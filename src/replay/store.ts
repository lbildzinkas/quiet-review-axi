import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson } from '../infra/canonical-json.js'

// The replay directory (spec 4.6): stage outputs, the stage records and the GitHub cache.
// It holds third-party comment text and code, so it lives under the git-ignored
// `.quiet-review/` by default (spec 10.9).

export const STAGES = ['build', 'label', 'check', 'score', 'evaluate'] as const
export type StageName = (typeof STAGES)[number]

export interface StageRecord {
  // Hash of the stage's inputs; a re-run with the same hash is a no-op.
  input_hash: string
  detail: string
  completed_at: string
  // A stage that ran but waits on something outside the tool, such as the maintainer's
  // review of the label check's disagreements. Absent means done.
  status?: 'waiting'
  counts?: Record<string, number>
  // Excluded items by reason (label stage).
  excluded_by_reason?: Record<string, number>
  warnings?: string[]
}

export interface Manifest {
  replay: string
  // The pre-registration hash of the config `build` ran with (spec 10.2).
  config_hash: string | null
  stages: Partial<Record<StageName, StageRecord>>
}

export function replayDir(cwd: string, name: string): string {
  return join(cwd, '.quiet-review', 'replays', name)
}

export function replayFiles(dir: string) {
  return {
    manifest: join(dir, 'manifest.json'),
    items: join(dir, 'items.jsonl'),
    labels: join(dir, 'labels.jsonl'),
    buildLog: join(dir, 'build-log.jsonl'),
    candidates: join(dir, 'candidates.jsonl'),
    check: join(dir, 'check.jsonl'),
    review: join(dir, 'review.jsonl'),
    finalLabels: join(dir, 'final-labels.jsonl'),
    github: join(dir, 'github'),
  }
}

export async function readManifest(dir: string, name: string): Promise<Manifest> {
  const text = await readOptional(replayFiles(dir).manifest)
  if (text === null) return { replay: name, config_hash: null, stages: {} }
  return JSON.parse(text) as Manifest
}

export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeAtomic(replayFiles(dir).manifest, `${JSON.stringify(manifest, null, 2)}\n`)
}

// JSON Lines with a fixed key order, so the same data always gives the same bytes (R17).
export function toJsonl(rows: unknown[]): string {
  return rows.map((row) => `${canonicalJson(row)}\n`).join('')
}

export function fromJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}
