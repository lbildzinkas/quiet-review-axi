import { runAxiCli } from 'axi-sdk-js'
import { scoreCommand } from './commands/score.js'
import type { AppContext } from './context.js'
import { exitCodeFor } from './errors.js'
import { renderError } from './output/errors.js'
import { VERSION } from './version.js'

const DESCRIPTION =
  'Scores AI code-review comments with Jev typed decisions so noise can be collapsed and real issues surface'

const TOP_LEVEL_HELP = `usage: quiet-review-axi <command> [args] [flags]
commands[1]:
  score <pr-url> | score --findings <file>
`

export async function main(context: AppContext): Promise<number> {
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await runAxiCli<AppContext>({
      description: DESCRIPTION,
      version: VERSION,
      argv: context.argv,
      stdout: context.stdout,
      topLevelHelp: TOP_LEVEL_HELP,
      resolveContext: () => context,
      home: () => ({
        help: ['Run `quiet-review-axi score --findings <file>` to score a findings file'],
      }),
      commands: { score: (args, ctx) => scoreCommand(args, ctx ?? context) },
      formatError: (error) => {
        const rendered = renderError(error)
        return { output: `${rendered.output}\n`, exitCode: exitCodeFor(rendered.code) }
      },
    })
    return Number(process.exitCode ?? 0)
  } finally {
    process.exitCode = previousExitCode
  }
}
