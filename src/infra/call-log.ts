import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CostSource } from './cache.js'

// One JSON line per Jev or label-model call attempt, cache hits included (spec 9.3). Callers pass only
// run facts: never state text, question text, comment bodies, keys or tokens.
export interface CallLogLine {
  ts: string
  run: string
  command: string
  provider: string
  model: string
  // Jev calls name their question pack, label-model calls their prompt template.
  question_pack?: string
  prompt?: string
  snapshot: string | null
  response_id: string | null
  request_hash: string
  items: number
  input_tokens: number | null
  output_tokens?: number | null
  cost_usd: number
  cost_source: CostSource | null
  cached: boolean
  latency_ms: number | null
  status: 'ok' | 'error'
  retries?: number
  error_code?: string
  http_status?: number
  error_body?: string
  notice?: string
  // The version of the CLI that made a label-model call on a subscription (spec 10.6).
  cli_version?: string
}

export async function appendCallLog(path: string, line: CallLogLine): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
}
