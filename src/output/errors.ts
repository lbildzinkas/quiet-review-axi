import { AxiError } from 'axi-sdk-js'
import { encode } from '@toon-format/toon'
import { joinBlocks, renderHelp } from './render.js'

export function renderError(error: unknown): { output: string; code: string } {
  if (error instanceof AxiError) {
    return {
      output: joinBlocks(
        encode({ error: error.message, code: error.code }),
        renderHelp(error.suggestions),
      ),
      code: error.code,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { output: encode({ error: message, code: 'UNKNOWN' }), code: 'UNKNOWN' }
}
