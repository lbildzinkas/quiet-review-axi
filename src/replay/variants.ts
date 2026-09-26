import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { validationError } from '../errors.js'

// The context blocks a variant can add to the Jev state. Each holds only what existed when the
// comment was written: the pull request's title and description, the issue it linked, and the
// commented file around the comment with the rest of its diff hunk.
export const CONTEXT_BLOCKS = ['pr_description', 'linked_issue', 'wider_code'] as const
export type ContextBlock = (typeof CONTEXT_BLOCKS)[number]

// The baseline is always scored and needs no entry: the replay's own requests.
export const BASELINE = 'baseline'

// Names the comparison's per-bot table already uses for its own columns.
const RESERVED_NAMES = [BASELINE, 'bot', 'items', 'real']

const variantsSchema = z
  .object({
    variants: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^[\w.-]+$/, 'must be letters, digits, dots, dashes or underscores')
              .refine(
                (name) => !RESERVED_NAMES.includes(name),
                `must not be ${RESERVED_NAMES.join(', ')} (the baseline is implicit)`,
              ),
            blocks: z
              .array(z.enum(CONTEXT_BLOCKS))
              .refine((blocks) => new Set(blocks).size === blocks.length, 'must not repeat'),
          })
          .strict(),
      )
      .min(1)
      .refine(
        (variants) => new Set(variants.map((variant) => variant.name)).size === variants.length,
        'must not repeat a variant name',
      ),
  })
  .strict()

export type Variant = z.infer<typeof variantsSchema>['variants'][number]

// A replay's variants are committed next to its config, at replay/<name>.variants.json.
export function defaultVariantsPath(cwd: string, name: string): string {
  return join(cwd, 'replay', `${name}.variants.json`)
}

export async function loadVariants(path: string, shown: string): Promise<Variant[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw validationError(`No variants file at ${shown}`, [
      'Write the variants file there, or pass `--variants <file>`',
    ])
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw validationError(`Variants file ${shown} is not valid JSON`)
  }
  const parsed = variantsSchema.safeParse(raw)
  if (parsed.success) return parsed.data.variants
  const issue = parsed.error.issues[0]
  throw validationError(
    `Invalid variants file ${shown}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
  )
}
