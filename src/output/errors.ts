import { AxiError } from 'axi-sdk-js'
import { encode } from '@toon-format/toon'
import { joinBlocks, renderHelp } from './render.js'

// Errors render as `error:`, `code:` and optional `help[n]:` (spec 4), or as one JSON
// document under --json.
export function renderError(error: unknown, asJson = false): { output: string; code: string } {
  const isKnown = error instanceof AxiError
  const message = error instanceof Error ? error.message : String(error)
  const code = isKnown ? error.code : 'UNKNOWN'
  const help = isKnown ? error.suggestions : []
  if (asJson) return { output: JSON.stringify({ error: message, code, help }, null, 2), code }
  return { output: joinBlocks(encode({ error: message, code }), renderHelp(help)), code }
}
