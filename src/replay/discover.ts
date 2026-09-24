import type { GitHubClient } from '../inputs/github.js'
import type { ReplayConfig } from './config.js'
import { countMergedPulls, fetchRepositoryMeta, searchMergedPulls } from './github.js'
import {
  botActivityRejection,
  busyRejection,
  languageRejection,
  metadataRejection,
  type Rejection,
} from './select.js'

// Candidate discovery (spec 10.3): merged PRs in the window that a listed bot commented on,
// found with the GitHub search API, grouped by repository and qualified. The maintainer
// chooses 5-8 of the qualifying repositories and commits them in the config before `build`.

export interface DiscoveredRepository {
  repository: string
  merged_prs: number
  // PRs each listed bot commented on, as found by search. GitHub returns at most 1,000
  // results per search, so these are lower bounds for very active bots.
  bot_prs: Record<string, number>
}

export interface Discovery {
  candidates: DiscoveredRepository[]
  rejected: Rejection[]
}

export async function runDiscovery(options: {
  config: ReplayConfig
  client: GitHubClient
  progress?: (line: string) => void
}): Promise<Discovery> {
  const { config, client } = options
  const progress = options.progress ?? (() => {})
  const pullsByRepository = new Map<string, Map<string, Set<number>>>()
  for (const bot of config.bots) {
    progress(`build: searching merged PRs with comments by ${bot}`)
    for (const hit of await searchMergedPulls(client, { window: config.window, commenter: bot })) {
      const byBot = pullsByRepository.get(hit.repository) ?? new Map<string, Set<number>>()
      byBot.set(bot, (byBot.get(bot) ?? new Set<number>()).add(hit.number))
      pullsByRepository.set(hit.repository, byBot)
    }
  }

  const candidates: DiscoveredRepository[] = []
  const rejected: Rejection[] = []
  const reject = (repository: string, reason: string) =>
    rejected.push({ kind: 'repository', candidate: repository, reason })
  for (const repository of [...pullsByRepository.keys()].sort()) {
    const byBot = pullsByRepository.get(repository)
    const botPrs = Object.fromEntries(config.bots.map((bot) => [bot, byBot?.get(bot)?.size ?? 0]))
    // Activity first: it needs no further request.
    const inactive = botActivityRejection(botPrs)
    if (inactive !== null) {
      reject(repository, inactive)
      continue
    }
    progress(`build: checking ${repository}`)
    const metadata = metadataRejection(await fetchRepositoryMeta(client, repository), config.bots)
    if (metadata !== null) {
      reject(repository, metadata)
      continue
    }
    const merged = await countMergedPulls(client, repository, config.window)
    const quiet = busyRejection(merged.total) ?? languageRejection(merged.titles)
    if (quiet !== null) {
      reject(repository, quiet)
      continue
    }
    candidates.push({ repository, merged_prs: merged.total, bot_prs: botPrs })
  }
  return { candidates, rejected }
}
