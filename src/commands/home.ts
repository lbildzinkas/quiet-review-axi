import { readdir, readFile } from 'node:fs/promises'
import type { AppContext } from '../context.js'
import { describeCutoffs, resolveCutoffs } from '../core/cutoffs.js'
import { findApiKey, loadRepoConfig, loadUserConfig } from '../infra/config.js'
import { cacheDir, callLogPath } from '../infra/paths.js'
import { findGitHubToken } from '../inputs/github.js'
import { PROVIDERS } from '../jev/providers.js'
import { roundCost } from '../output/render.js'
import { latestResult, replaysRoot } from './report.js'

// The no-command view (spec 4.3). Credentials show only their source, never their value.
export async function homeView(context: AppContext): Promise<Record<string, unknown>> {
  const userConfig = await loadUserConfig(context)
  const repoConfig = await loadRepoConfig(context)
  const provider = PROVIDERS[userConfig.provider ?? 'openrouter']
  const key = findApiKey(provider, context.env, userConfig)
  const token = await findGitHubToken(context.env, context.runGhAuthToken)
  const cutoffs = resolveCutoffs({ repoConfig: repoConfig.cutoffs, userConfig: userConfig.cutoffs })
  const lastReplay = await latestResult(replaysRoot(context.cwd))
  return {
    provider: provider.name,
    model: provider.model,
    key: key ? `set (${key.source})` : 'missing',
    github_token: token ? `set (${token.source})` : 'missing',
    cutoffs: describeCutoffs(cutoffs, []).line,
    cache: `${await countCacheEntries(cacheDir(context.env))} entries`,
    spent_today_usd: roundCost(await spentOn(callLogPath(context.env), context.now())),
    ...(lastReplay === null
      ? {}
      : {
          last_replay: `${lastReplay.replay} ${lastReplay.verdict} auroc=${lastReplay.auroc === null ? 'n/a' : Number(lastReplay.auroc.toFixed(3))}`,
        }),
  }
}

export const HOME_HELP = [
  "Run `quiet-review-axi score <pr-url>` to score a pull request's review comments",
  'Run `quiet-review-axi score --findings <file>` to score a findings file',
  'Run `quiet-review-axi report` to see the latest replay result',
]

async function countCacheEntries(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

// Sums cost_usd of today's (UTC) lines in the cost log.
async function spentOn(path: string, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return 0
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .reduce((total, line) => {
      try {
        const entry = JSON.parse(line) as { ts?: string; cost_usd?: number }
        return entry.ts?.startsWith(day) ? total + (entry.cost_usd ?? 0) : total
      } catch {
        return total
      }
    }, 0)
}
