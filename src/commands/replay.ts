import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { validationError } from '../errors.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import { joinBlocks } from '../output/render.js'
import { runBuild } from '../replay/build.js'
import { createReplayFetch } from '../replay/fetch.js'
import { defaultConfigPath, loadReplayConfig } from '../replay/config.js'
import { labelComment } from '../replay/label.js'

const REPLAY_FLAGS = {
  stage: { type: 'string' },
  config: { type: 'string' },
  dir: { type: 'string' },
  json: { type: 'boolean' },
} as const

export async function replayCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  const name = positionals[0] ?? 'default'
  const configPath = values.config ?? defaultConfigPath(context.cwd, name)
  const { config } = await loadReplayConfig(configPath, name)
  const token = await requireGitHubToken(context.env, context.runGhAuthToken)
  const client = createGitHubClient({
    token: token.token,
    fetch: createReplayFetch(context),
    callerPacesSearch: true,
  })
  const build = await runBuild({ config, client })
  const labels = build.items.map((item) => labelComment(item.evidence).label)
  const count = (label: string) => labels.filter((entry) => entry === label).length
  const { summary } = build
  return joinBlocks(
    encode({
      replay: name,
      stages: [
        {
          stage: 'build',
          status: 'done',
          detail: `${summary.repositories} repos, ${summary.bots} bots, ${summary.comments} comments from ${summary.prs} PRs`,
        },
        {
          stage: 'label',
          status: 'done',
          detail: `real ${count('real')}, noise ${count('noise')}, excluded ${count('excluded')}`,
        },
      ],
    }),
  )
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: REPLAY_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi replay --help` to see the flags',
    ])
  }
}
