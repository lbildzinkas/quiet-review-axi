import type { GitHubClient } from '../inputs/github.js'
import type { ReplayConfig } from './config.js'
import { isBot } from '../inputs/pull-request.js'
import {
  fetchCompare,
  fetchFileLines,
  fetchThreadResolution,
  fetchReplayPull,
  searchMergedPulls,
  type CompareResult,
  type ReplayComment,
  type ReplayPull,
} from './github.js'
import { labelComment, type Evidence, type Reply } from './label.js'
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
  const threads = new Map<string, Map<number, boolean>>()
  const evidenceFor = async (candidate: EligibleComment): Promise<Evidence> => {
    const { comment, pull } = candidate
    const from = comment.original_commit_id
    const to = pull.headSha
    const compareKey = `${candidate.repository}:${from}...${to}`
    if (!compares.has(compareKey))
      compares.set(compareKey, await fetchCompare(client, candidate.repository, from, to))
    const compare = compares.get(compareKey) ?? null
    if (!threads.has(candidate.pr))
      threads.set(candidate.pr, await fetchThreadResolution(client, pull.repository, pull.number))
    const file = compare?.files.find((entry) => entry.filename === comment.path) ?? null
    const needsLines = file !== null && file.deletions > 0
    return {
      from,
      to,
      anchor: anchorOf(comment),
      compare:
        compare === null
          ? null
          : { merge_base: compare.mergeBase, files_listed: compare.files.length, file },
      file_lines: needsLines
        ? await fetchFileLines(client, candidate.repository, comment.path, from)
        : null,
      resolved: threads.get(candidate.pr)?.get(comment.id) ?? false,
      replies: repliesTo(pull, comment.id),
    }
  }

  const evidence = new Map<string, Evidence>()
  const draws = await drawSample({
    candidates,
    target: config.target_items,
    maxSharePerRepository: config.max_share_per_repository,
    maxSharePerBot: config.max_share_per_bot,
    maxItemsPerPr: config.max_items_per_pr,
    seed: config.seed,
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

// Bot summaries and walkthroughs posted as inline comments, by their known markers.
const SUMMARY_MARKERS = [
  /<!--\s*walkthrough_start\s*-->/i,
  /<!--\s*This is an auto-generated comment: summarize by coderabbit\.ai\s*-->/i,
  /^#{1,3}\s*Walkthrough\b/im,
  /^#{1,3}\s*Pull Request Overview\b/im,
  /^#{1,3}\s*Greptile Summary\b/im,
  /<h3>\s*Greptile Summary\s*<\/h3>/i,
]

// Eligibility (spec 10.4): a thread-root inline comment by a configured bot, on a PR merged
// inside the window, with a diff hunk and a line anchor, that is not a bot summary.
function eligibleComments(pull: ReplayPull, config: ReplayConfig): EligibleComment[] {
  if (!isMergedInWindow(pull, config.window)) return []
  return pull.comments
    .filter((comment) => comment.in_reply_to_id === undefined || comment.in_reply_to_id === null)
    .filter((comment) => config.bots.includes(comment.user?.login ?? ''))
    .filter((comment) => comment.diff_hunk.length > 0)
    .filter((comment) => (comment.line ?? comment.original_line) !== null)
    .filter((comment) => !SUMMARY_MARKERS.some((marker) => marker.test(comment.body)))
    .map((comment) => ({
      key: `${pull.repository}#${pull.number}/r${comment.id}`,
      repository: pull.repository,
      bot: comment.user?.login ?? '',
      pr: `${pull.repository}#${pull.number}`,
      pull,
      comment,
    }))
}

// The window includes merged_after and excludes merged_before (UTC days).
function isMergedInWindow(pull: ReplayPull, window: ReplayConfig['window']): boolean {
  if (pull.mergedAt === null) return false
  const merged = new Date(pull.mergedAt).getTime()
  return (
    merged >= Date.parse(`${window.merged_after}T00:00:00Z`) &&
    merged < Date.parse(`${window.merged_before}T00:00:00Z`)
  )
}

// The commented range on the new side at `from`. A comment on the old side (LEFT) has none.
function anchorOf(comment: ReplayComment): Evidence['anchor'] {
  const end = comment.original_line
  if (end === null || comment.side === 'LEFT') return null
  return { start: comment.original_start_line ?? end, end }
}

function repliesTo(pull: ReplayPull, rootId: number): Reply[] {
  return pull.comments
    .filter((comment) => comment.in_reply_to_id === rootId)
    .sort((a, b) => compareText(a.created_at, b.created_at) || a.id - b.id)
    .map((comment) => ({
      author: comment.user?.login ?? '',
      is_bot: isBot(comment.user),
      body: comment.body,
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
