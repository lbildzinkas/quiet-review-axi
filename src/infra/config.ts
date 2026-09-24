import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { QuietReviewError, validationError } from '../errors.js'
import type { ProviderName } from '../jev/provider.js'
import { REPO_CONFIG_FILE, userConfigPath } from './paths.js'

const probability = z.number().min(0).max(1)

// A file that sets both cut-offs must hold them in order on its own (spec 6.1), even when a
// flag overrides one of them for a run.
function checkOrder(
  cutoffs: { collapse_below?: number; keep_at?: number },
  context: z.core.$RefinementCtx,
) {
  const { collapse_below: collapseBelow, keep_at: keepAt } = cutoffs
  if (collapseBelow === undefined || keepAt === undefined || collapseBelow <= keepAt) return
  context.addIssue({
    code: 'custom',
    path: ['collapse_below'],
    message: `${collapseBelow} is above cutoffs.keep_at ${keepAt}; collapse_below must be at most keep_at`,
  })
}

const userConfigSchema = z.object({
  provider: z.enum(['openrouter', 'typesafe']).optional(),
  keys: z
    .object({ openrouter: z.string().optional(), typesafe: z.string().optional() })
    .strict()
    .optional(),
  allow_private: z.array(z.string()).optional(),
  cutoffs: z
    .object({
      collapse_below: probability.optional(),
      keep_at: probability.optional(),
      replay: z.string().optional(),
      snapshot: z.string().optional(),
      tested_collapse_below: probability.optional(),
      written_at: z.string().optional(),
    })
    .strict()
    .superRefine(checkOrder)
    .optional(),
})

const repoConfigSchema = z
  .object({
    cutoffs: z
      .object({ collapse_below: probability.optional(), keep_at: probability.optional() })
      .strict()
      .superRefine(checkOrder)
      .optional(),
  })
  .strict()

export type UserConfig = z.infer<typeof userConfigSchema>
export type RepoConfig = z.infer<typeof repoConfigSchema>

interface ConfigContext {
  env: Record<string, string | undefined>
  cwd: string
}

// The files cut-offs are read from (spec 6.2), keyed by the source name printed in output.
export function cutoffFiles(context: ConfigContext): {
  'repo config': string
  'user config': string
} {
  return {
    'repo config': join(context.cwd, REPO_CONFIG_FILE),
    'user config': userConfigPath(context.env),
  }
}

// The user config (spec 9.1). A file holding keys must be readable only by its owner.
export async function loadUserConfig(context: ConfigContext): Promise<UserConfig> {
  const path = userConfigPath(context.env)
  const text = await readOptional(path)
  if (text === null) return {}
  const config = parseConfig(userConfigSchema, text, path)
  if (config.keys !== undefined && process.platform !== 'win32') {
    const { mode } = await stat(path)
    if ((mode & 0o077) !== 0)
      throw new QuietReviewError(
        'CONFIG_PERMISSIONS',
        `The config file ${path} holds keys but others can read it`,
        [`Run \`chmod 600 ${path}\` so only you can read it`],
      )
  }
  return config
}

// The repository config may hold only cut-offs, never keys or privacy opt-ins (spec 9.1).
export async function loadRepoConfig(context: ConfigContext): Promise<RepoConfig> {
  const path = join(context.cwd, REPO_CONFIG_FILE)
  const text = await readOptional(path)
  if (text === null) return {}
  const raw = parseJsonFile(text, path) as Record<string, unknown>
  if (raw !== null && typeof raw === 'object' && ('keys' in raw || 'allow_private' in raw))
    throw validationError(
      `${REPO_CONFIG_FILE} may hold only cutoffs; keys and allow_private belong in the user config`,
      [`Remove \`keys\` and \`allow_private\` from ${REPO_CONFIG_FILE}`],
    )
  return parseConfig(repoConfigSchema, text, path)
}

function parseConfig<T>(schema: z.ZodType<T>, text: string, path: string): T {
  const parsed = schema.safeParse(parseJsonFile(text, path))
  if (!parsed.success)
    throw validationError(`Invalid config file ${path}: ${describeIssue(parsed.error.issues[0])}`)
  return parsed.data
}

// Names the offending key in full, so an unknown key reads `cutoffs.keep`, not `cutoffs`.
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return '(root) is invalid'
  const at = (keys: PropertyKey[]) => keys.map(String).join('.') || '(root)'
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map((key) => `${at([...issue.path, key])} is not a known key`).join(', ')
  return `${at(issue.path)} ${issue.message}`
}

function parseJsonFile(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw validationError(`Config file ${path} is not valid JSON`)
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export interface ApiKey {
  key: string
  source: string
}

// Key lookup (spec 9.1): the provider's environment variable, then the user config.
export function findApiKey(
  provider: { name: ProviderName; keyEnv: string },
  env: Record<string, string | undefined>,
  config: UserConfig,
): ApiKey | null {
  const fromEnv = env[provider.keyEnv]
  if (fromEnv) return { key: fromEnv, source: `env ${provider.keyEnv}` }
  const fromConfig = config.keys?.[provider.name]
  return fromConfig ? { key: fromConfig, source: 'config file' } : null
}

export function missingKeyError(provider: { name: ProviderName; keyEnv: string }) {
  return new QuietReviewError('MISSING_KEY', `No API key for ${provider.name}`, [
    `Set \`${provider.keyEnv}\`, or add \`keys.${provider.name}\` to the user config file (mode 600)`,
  ])
}

// Every key and token a run may hold, for its redactor (spec 9.1).
export function secretsOf(
  env: Record<string, string | undefined>,
  userConfig: UserConfig,
): (string | undefined)[] {
  return [
    env.OPENROUTER_API_KEY,
    env.TYPESAFE_API_KEY,
    env.GITHUB_TOKEN,
    env.GH_TOKEN,
    userConfig.keys?.openrouter,
    userConfig.keys?.typesafe,
  ]
}

// Key values from the user config, for the redactor. Unreadable or invalid files add none.
export async function configSecrets(context: ConfigContext): Promise<string[]> {
  const text = await readOptional(userConfigPath(context.env)).catch(() => null)
  if (text === null) return []
  try {
    const keys = (JSON.parse(text) as { keys?: Record<string, unknown> }).keys ?? {}
    return Object.values(keys).filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

// Writes calibrated cut-offs to the user config (spec 6.2), keeping every other field. The
// file may hold keys, so it is written readable only by its owner. Returns the cut-offs it
// replaced, so the caller can print them.
export async function writeUserCutoffs(
  context: ConfigContext,
  cutoffs: NonNullable<UserConfig['cutoffs']>,
): Promise<{ path: string; replaced: UserConfig['cutoffs'] }> {
  const path = userConfigPath(context.env)
  const text = await readOptional(path)
  const current = text === null ? {} : (parseJsonFile(text, path) as Record<string, unknown>)
  const replaced = (await loadUserConfig(context)).cutoffs
  const next = { ...current, cutoffs }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  return { path, replaced }
}
