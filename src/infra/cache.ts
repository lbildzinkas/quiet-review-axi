import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical-json.js'

// Cache key (spec 9.2): SHA-256 of the canonical JSON of { provider, endpoint, body }.
// The body is the exact request body, including the model; it never includes the API key.
export function cacheKey(input: { provider: string; endpoint: string; body: unknown }): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}
