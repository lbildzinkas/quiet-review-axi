import type { GitHubClient } from '../inputs/github.js'
import type { ReplayConfig } from './config.js'
import {
  fetchCompare,
  fetchReplayPull,
  searchMergedPulls,
  type CompareResult,
  type ReplayComment,
  type ReplayPull,
} from './github.js'
import { labelComment, type Evidence } from './label.js'
import { drawSample, type Candidate } from './sample.js'

// One drawn comment with everything the label stage needs (spec 10.4, 10.5).
export interface DrawnItem {
  id: string
  repository: string
  pr: number
  bot: string
  comment: {
    id: number
    url: string
    path: string
    lines: string
    body: string
    diff_hunk: string
    created_at: string
  }
  evidence: Evidence
}

export interface BuildSummary {
  repositories: number
  bots: number
  comments: number
  prs: number
}

export interface BuildResult {
  items: DrawnItem[]
  summary: BuildSummary
}

interface EligibleComment extends Candidate {
  pull: ReplayPull
  comment: ReplayComment
}

export async function runBuild(options: {
  config: ReplayConfig
  client: GitHubClient
}): Promise<BuildResult> {
  const { config, client } = options
  const candidates: EligibleComment[] = []
  for (const repository of config.repositories) {
    const numbers = new Set<number>()
    for (const bot of config.bots) {
      const hits = await searchMergedPulls(client, {
        window: config.window,
        repository,
        commenter: bot,
      })
      for (const hit of hits) numbers.add(hit.number)
    }
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const pull = await fetchReplayPull(client, repository, number)
      candidates.push(...eligibleComments(pull, config))
    }
  }
  candidates.sort((a, b) => compareText(a.key, b.key))

  const compares = new Map<string, CompareResult | null>()
  const evidenceFor = async (candidate: EligibleComment): Promise<Evidence> => {
    const from = candidate.comment.original_commit_id
    const to = candidate.pull.headSha
    const compareKey = `${candidate.repository}:${from}...${to}`
    if (!compares.has(compareKey))
      compares.set(compareKey, await fetchCompare(client, candidate.repository, from, to))
    const compare = compares.get(compareKey) ?? null
    const line = candidate.comment.original_line
    return {
      from,
      to,
      anchor:
        line === null ? null : { start: candidate.comment.original_start_line ?? line, end: line },
      file: compare?.files.find((file) => file.filename === candidate.comment.path) ?? null,
    }
  }

  const evidence = new Map<string, Evidence>()
  const draws = await drawSample({
    candidates,
    target: config.target_items,
    isExcluded: async (candidate) => {
      const found = await evidenceFor(candidate)
      evidence.set(candidate.key, found)
      return labelComment(found).label === 'excluded'
    },
  })
  const items = draws.map(({ candidate }): DrawnItem => {
    const { comment } = candidate
    const found = evidence.get(candidate.key)
    if (!found) throw new Error(`No evidence recorded for ${candidate.key}`)
    return {
      id: candidate.key,
      repository: candidate.repository,
      pr: candidate.pull.number,
      bot: candidate.bot,
      comment: {
        id: comment.id,
        url: comment.html_url,
        path: comment.path,
        lines: lineRange(comment),
        body: comment.body,
        diff_hunk: comment.diff_hunk,
        created_at: comment.created_at,
      },
      evidence: found,
    }
  })
  return { items, summary: summarize(items) }
}

function eligibleComments(pull: ReplayPull, config: ReplayConfig): EligibleComment[] {
  return pull.comments
    .filter((comment) => comment.in_reply_to_id === undefined || comment.in_reply_to_id === null)
    .filter((comment) => config.bots.includes(comment.user?.login ?? ''))
    .map((comment) => ({
      key: `${pull.repository}#${pull.number}/r${comment.id}`,
      repository: pull.repository,
      bot: comment.user?.login ?? '',
      pr: `${pull.repository}#${pull.number}`,
      pull,
      comment,
    }))
}

function lineRange(comment: ReplayComment): string {
  const end = comment.original_line
  const start = comment.original_start_line
  return start !== null && start !== end ? `${start}-${end}` : String(end)
}

function summarize(items: DrawnItem[]): BuildSummary {
  return {
    repositories: new Set(items.map((item) => item.repository)).size,
    bots: new Set(items.map((item) => item.bot)).size,
    comments: items.length,
    prs: new Set(items.map((item) => `${item.repository}#${item.pr}`)).size,
  }
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
