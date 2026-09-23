import { runAxiCli } from 'axi-sdk-js'
import { scoreCommand } from './commands/score.js'
import type { AppContext } from './context.js'
import { BudgetStop, exitCodeFor } from './errors.js'
import { configSecrets } from './infra/config.js'
import { createRedactor } from './infra/redact.js'
import { renderError } from './output/errors.js'
import { VERSION } from './version.js'

const DESCRIPTION =
  'Scores AI code-review comments with Jev typed decisions so noise can be collapsed and real issues surface'

const TOP_LEVEL_HELP = `usage: quiet-review-axi <command> [args] [flags]
commands[1]:
  score <pr-url> | score --findings <file>
`

export async function main(context: AppContext): Promise<number> {
  // Keys from the user config are added to the redactor once the config is read.
  const redact = createRedactor([
    context.env.OPENROUTER_API_KEY,
    context.env.TYPESAFE_API_KEY,
    context.env.GITHUB_TOKEN,
    context.env.GH_TOKEN,
    ...(await configSecrets(context)),
  ])
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
        if (error instanceof BudgetStop) return { output: `${error.renderedOutput}\n`, exitCode: 3 }
        const rendered = renderError(error, wantsJson(context.argv))
        return { output: `${redact(rendered.output)}\n`, exitCode: exitCodeFor(rendered.code) }
      },
    })
    return Number(process.exitCode ?? 0)
  } finally {
    process.exitCode = previousExitCode
  }
}

function wantsJson(argv: string[]): boolean {
  return argv.includes('--json') && !argv.includes('--human')
}
