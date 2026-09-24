import { encode } from '@toon-format/toon'
import { runAxiCli } from 'axi-sdk-js'
import { HOME_HELP, homeView } from './commands/home.js'
import { replayCommand } from './commands/replay.js'
import { SCORE_HELP, scoreCommand } from './commands/score.js'
import { updateCommand } from './commands/update.js'
import type { AppContext } from './context.js'
import { BudgetStop, exitCodeFor } from './errors.js'
import { configSecrets } from './infra/config.js'
import { createRedactor } from './infra/redact.js'
import { renderError } from './output/errors.js'
import { joinBlocks, renderHelp } from './output/render.js'
import { VERSION } from './version.js'

const DESCRIPTION =
  'Scores AI code-review comments with Jev typed decisions so noise can be collapsed and real issues surface'

const TOP_LEVEL_HELP = `${encode({
  usage: 'quiet-review-axi <command> [args] [flags]',
  commands: {
    score: "Score a pull request's review comments, or a findings file, with Jev",
    update: 'Show how to install the latest version from the repository',
  },
})}
${renderHelp([
  'Run `quiet-review-axi score --help` for the score flags',
  'Run `quiet-review-axi` with no command to see the current setup',
])}
`

export async function main(context: AppContext): Promise<number> {
  // Every error path is redacted: keys from the environment and the user config, and tokens.
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
      home: async (_args, ctx) =>
        joinBlocks(encode(await homeView(ctx ?? context)), renderHelp(HOME_HELP)),
      commands: {
        score: (args, ctx) => scoreCommand(args, ctx ?? context),
        replay: (args, ctx) => replayCommand(args, ctx ?? context),
        update: (args) => updateCommand(args),
      },
      getCommandHelp: (command) => (command === 'score' ? `${SCORE_HELP}\n` : null),
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
