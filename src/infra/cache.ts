import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JevResponse } from '../jev/schema.js'
import { canonicalJson } from './canonical-json.js'

// Cache key (spec 9.2): SHA-256 of the canonical JSON of { provider, endpoint, body }.
// The body is the exact request body, including the model; it never includes the API key.
export function cacheKey(input: { provider: string; endpoint: string; body: unknown }): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

export interface CacheEntry {
  response: JevResponse
  cachedAt: string
  latencyMs: number
  costUsd: number
  costSource: 'reported' | 'computed'
}

export async function readCacheEntry(dir: string, key: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')) as CacheEntry
  } catch {
    return null
  }
}

// Written atomically, and only for responses that passed validation (spec 5.5).
export async function writeCacheEntry(dir: string, key: string, entry: CacheEntry): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${key}.json`)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 })
  await rename(temporary, path)
}
