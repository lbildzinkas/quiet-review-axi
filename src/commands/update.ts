import { encode } from '@toon-format/toon'
import { validationError } from '../errors.js'
import { joinBlocks, renderHelp } from '../output/render.js'
import { VERSION } from '../version.js'

const REPOSITORY_INSTALL = 'npm install -g github:lbildzinkas/quiet-review-axi'

// Shadows the SDK's npm self-update: v0 is installed from the repository and is not
// published to npm (R15), so an npm install could fetch an unrelated package.
export function updateCommand(args: string[]): string {
  const unknown = args.filter((arg) => arg !== '--check' && arg !== '--dry-run')
  if (unknown.length > 0) throw validationError(`Unknown update arguments: ${unknown.join(' ')}`)
  return joinBlocks(
    encode({
      update:
        'installed from the repository; npm updates are not available before the replay passes',
      current: VERSION,
      command: REPOSITORY_INSTALL,
    }),
    renderHelp([`Run \`${REPOSITORY_INSTALL}\` to install the latest version from the repository`]),
  )
}
