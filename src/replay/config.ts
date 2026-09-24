import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { validationError } from '../errors.js'
import { canonicalJson } from '../infra/canonical-json.js'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
const share = z.number().gt(0).max(1)
const positiveInteger = z.number().int().positive()
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/repo')

function unique(values: string[]): boolean {
  return new Set(values).size === values.length
}

// Pi's thinking levels (`pi --thinking`).
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

// How the label check reaches its model (spec 10.6): OpenRouter's paid chat API when `backend`
// is absent or `openrouter`, or the Pi CLI on a subscription, which also needs `thinking`.
const labelCheckSchema = z
  .object({
    sample_size: positiveInteger,
    backend: z.enum(['openrouter', 'pi']).optional(),
    model: z.string().min(1),
    thinking: z.enum(PI_THINKING_LEVELS).optional(),
    timeout_seconds: z.number().positive().optional(),
  })
  .strict()
  .superRefine((check, context) => {
    const isPi = check.backend === 'pi'
    if (isPi && check.thinking === undefined)
      context.addIssue({
        code: 'custom',
        path: ['thinking'],
        message: `is required with backend pi: one of ${PI_THINKING_LEVELS.join(', ')}`,
      })
    for (const field of ['thinking', 'timeout_seconds'] as const)
      if (!isPi && check[field] !== undefined)
        context.addIssue({ code: 'custom', path: [field], message: 'is only for backend pi' })
  })

// The replay config (spec 10.2). Strict, so a typo cannot silently change the experiment.
const replayConfigSchema = z
  .object({
    name: z.string().min(1),
    window: z.object({ merged_after: day, merged_before: day }).strict(),
    repositories: z.array(repository).refine(unique, 'must not repeat a repository'),
    bots: z.array(z.string().min(1)).min(1).refine(unique, 'must not repeat a bot'),
    target_items: positiveInteger,
    max_share_per_repository: share,
    max_share_per_bot: share,
    max_items_per_pr: positiveInteger,
    seed: z.number().int(),
    label_check: labelCheckSchema,
    pass_rule: z
      .object({
        min_auroc: z.number().min(0).max(1),
        min_noise_collapsed: z.number().min(0).max(1),
        max_real_hidden: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict()

export type ReplayConfig = z.infer<typeof replayConfigSchema>

export interface LoadedReplayConfig {
  path: string
  config: ReplayConfig
  // Pre-registration hash: SHA-256 of the canonical JSON of the parsed config.
  hash: string
}

// Replay configs are committed at replay/<name>.config.json (spec 10.2).
export function defaultConfigPath(cwd: string, name: string): string {
  return join(cwd, 'replay', `${name}.config.json`)
}

export async function loadReplayConfig(path: string, name: string): Promise<LoadedReplayConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw validationError(`No replay config at ${path}`, [
      'Write the replay config (spec 10.2) there, or pass `--config <file>`',
    ])
  }
  const config = parseReplayConfig(text, path)
  if (config.name !== name)
    throw validationError(`The replay config ${path} is named ${config.name}, not ${name}`, [
      `Run \`quiet-review-axi replay ${config.name}\`, or fix \`name\` in the config`,
    ])
  return { path, config, hash: configHash(config) }
}

function parseReplayConfig(text: string, path: string): ReplayConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw validationError(`Replay config ${path} is not valid JSON`)
  }
  const parsed = replayConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw validationError(
      `Invalid replay config ${path}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
    )
  }
  const { window } = parsed.data
  if (window.merged_after >= window.merged_before)
    throw validationError(
      `Invalid replay config ${path}: window.merged_after must be before window.merged_before`,
    )
  return parsed.data
}

export function configHash(config: ReplayConfig): string {
  return `sha256:${createHash('sha256').update(canonicalJson(config)).digest('hex')}`
}
