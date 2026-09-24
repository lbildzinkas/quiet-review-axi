import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { QuietReviewError, validationError } from '../errors.js'
import type { ProviderName } from '../jev/provider.js'
import { REPO_CONFIG_FILE, userConfigPath } from './paths.js'

const probability = z.number().min(0).max(1)

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
    .optional(),
})

const repoConfigSchema = z
  .object({
    cutoffs: z
      .object({ collapse_below: probability.optional(), keep_at: probability.optional() })
      .strict()
      .optional(),
  })
  .strict()

export type UserConfig = z.infer<typeof userConfigSchema>
export type RepoConfig = z.infer<typeof repoConfigSchema>

interface ConfigContext {
  env: Record<string, string | undefined>
  cwd: string
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
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw validationError(
      `Invalid config file ${path}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
    )
  }
  return parsed.data
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
