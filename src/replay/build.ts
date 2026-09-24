import type { GitHubClient } from '../inputs/github.js'
import type { ReplayConfig } from './config.js'
import { isBot } from '../inputs/pull-request.js'
import {
  countMergedPulls,
  fetchCompare,
  fetchRepositoryMeta,
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
import {
  botActivityRejection,
  busyRejection,
  languageRejection,
  metadataRejection,
  type Rejection,
} from './select.js'

// One drawn comment with everything the label stage needs (spec 10.4, 10.5).
export interface DrawnItem {
  id: string
  repository: string
  pr: number
  // The pull request's title, which goes into the Jev state as `score` sends it (spec 5.3).
  title: string
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
  rejected: Rejection[]
  warnings: string[]
}

const MIN_BOTS = 3
export const MIN_REPOSITORIES = 5
export const MAX_REPOSITORIES = 8

interface EligibleComment extends Candidate {
  pull: ReplayPull
  comment: ReplayComment
}

export async function runBuild(options: {
  config: ReplayConfig
  client: GitHubClient
  progress?: (line: string) => void
}): Promise<BuildResult> {
  const { config, client } = options
  const progress = options.progress ?? (() => {})
  const rejected: Rejection[] = []
  const candidates: EligibleComment[] = []
  const prsPerBot: Record<string, number> = Object.fromEntries(config.bots.map((bot) => [bot, 0]))
  for (const repository of config.repositories) {
    progress(`build: checking ${repository}`)
    const qualified = await qualifyRepository(client, repository, config)
    if ('reason' in qualified) {
      rejected.push({ kind: 'repository', candidate: repository, reason: qualified.reason })
      continue
    }
    for (const [bot, count] of Object.entries(qualified.prsPerBot))
      prsPerBot[bot] = (prsPerBot[bot] ?? 0) + count
    for (const pull of qualified.pulls) candidates.push(...eligibleComments(pull, config))
  }
  for (const bot of config.bots)
    if (prsPerBot[bot] === 0)
      rejected.push({
        kind: 'bot',
        candidate: bot,
        reason: 'no inline review comments in the qualifying repositories in the window',
      })
  candidates.sort((a, b) => compareText(a.key, b.key))
  progress(`build: drawing from ${candidates.length} eligible comments`)

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
    // A file renamed after the comment is listed under its new name.
    const file =
      compare?.files.find(
        (entry) => entry.filename === comment.path || entry.previous_filename === comment.path,
      ) ?? null
    // Rule 2 needs the file's size at `from`; deleted and renamed files are excluded anyway.
    const needsLines =
      file !== null && file.status !== 'removed' && file.status !== 'renamed' && file.deletions > 0
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
      title: candidate.pull.title,
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
  const summary = summarize(items)
  return { items, summary, rejected, warnings: coverageWarnings(summary) }
}

type Qualification = { reason: string } | { pulls: ReplayPull[]; prsPerBot: Record<string, number> }

// Applies the criteria of spec 10.3, cheapest reads first, and returns the repository's PRs
// merged in the window that the listed bots commented on.
async function qualifyRepository(
  client: GitHubClient,
  repository: string,
  config: ReplayConfig,
): Promise<Qualification> {
  const metadata = metadataRejection(await fetchRepositoryMeta(client, repository), config.bots)
  if (metadata !== null) return { reason: metadata }
  const merged = await countMergedPulls(client, repository, config.window)
  const quiet = busyRejection(merged.total) ?? languageRejection(merged.titles)
  if (quiet !== null) return { reason: quiet }
  const numbers = new Set<number>()
  for (const bot of config.bots) {
    const hits = await searchMergedPulls(client, {
      window: config.window,
      repository,
      commenter: bot,
    })
    for (const hit of hits) numbers.add(hit.number)
  }
  const pulls: ReplayPull[] = []
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const pull = await fetchReplayPull(client, repository, number)
    if (isMergedInWindow(pull, config.window)) pulls.push(pull)
  }
  const prsPerBot = Object.fromEntries(
    config.bots.map((bot) => [
      bot,
      pulls.filter((pull) => pull.comments.some((comment) => comment.user?.login === bot)).length,
    ]),
  )
  const inactive = botActivityRejection(prsPerBot)
  return inactive === null ? { pulls, prsPerBot } : { reason: inactive }
}

// R9 asks for 5-8 repositories and at least 3 bots; a smaller dataset is reported, not refused.
function coverageWarnings(summary: BuildSummary): string[] {
  const warnings: string[] = []
  const counted = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`
  if (summary.bots < MIN_BOTS)
    warnings.push(
      `the dataset covers ${counted(summary.bots, 'bot', 'bots')}; R9 asks for at least ${MIN_BOTS}`,
    )
  if (summary.repositories < MIN_REPOSITORIES || summary.repositories > MAX_REPOSITORIES)
    warnings.push(
      `the dataset covers ${counted(summary.repositories, 'repository', 'repositories')}; R9 asks for ${MIN_REPOSITORIES}-${MAX_REPOSITORIES}`,
    )
  return warnings
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
