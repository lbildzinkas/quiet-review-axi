import type { GitHubClient } from '../inputs/github.js'
import type { ReplayConfig } from './config.js'
import { isBot } from '../inputs/pull-request.js'
import {
  countMergedPulls,
  fetchBranchCommits,
  fetchCommitFiles,
  fetchCompare,
  fetchRepositoryMeta,
  fetchFileLines,
  fetchPullCommits,
  fetchReplayPull,
  fetchReviewThreads,
  searchMergedPulls,
  type CompareResult,
  type ReplayComment,
  type ReplayPull,
} from './github.js'
import { isChangedAt, labelComment, type Evidence, type LaterCommit, type Reply } from './label.js'
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
  // The pull request's title and description: the title goes into the Jev state as `score`
  // sends it (spec 5.3), and both go to the label-check model (spec 10.6, label-rules-v2).
  title: string
  description: string
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
  const threads = new Map<string, Awaited<ReturnType<typeof fetchReviewThreads>>>()
  const commits = new Map<string, LaterCommit[]>()
  const branchCommits = new Map<string, { sha: string; subject: string; date: string }[]>()
  const evidenceFor = async (candidate: EligibleComment): Promise<Evidence> => {
    const { comment, pull } = candidate
    const from = comment.original_commit_id
    const to = pull.headSha
    const compareKey = `${candidate.repository}:${from}...${to}`
    if (!compares.has(compareKey))
      compares.set(compareKey, await fetchCompare(client, candidate.repository, from, to))
    const compare = compares.get(compareKey) ?? null
    const prKey = `${pull.repository}#${pull.number}`
    if (!threads.has(prKey))
      threads.set(prKey, await fetchReviewThreads(client, pull.repository, pull.number))
    if (!commits.has(prKey))
      commits.set(prKey, await fetchPullCommits(client, pull.repository, pull.number))
    // The commits after the comment's commit: a reply naming one of them agrees, and their
    // subjects are matched against the comment heading (label-rules-v2).
    const pullCommits = commits.get(prKey) ?? []
    const fromIndex = pullCommits.findIndex((commit) => commit.sha === from)
    const commitsAfter = fromIndex === -1 ? [] : pullCommits.slice(fromIndex + 1)
    // A file renamed after the comment is listed under its new name.
    const file =
      compare?.files.find(
        (entry) => entry.filename === comment.path || entry.previous_filename === comment.path,
      ) ?? null
    // Rule 2 needs the file's size at `from`; deleted and renamed files are excluded anyway.
    const needsLines =
      file !== null && file.status !== 'removed' && file.status !== 'renamed' && file.deletions > 0
    const thread = threads.get(prKey)?.get(comment.id)
    const anchor = anchorOf(comment)
    return {
      from,
      to,
      anchor,
      compare:
        compare === null
          ? null
          : { merge_base: compare.mergeBase, files_listed: compare.files.length, file },
      file_lines: needsLines
        ? await fetchFileLines(client, candidate.repository, comment.path, from)
        : null,
      resolved: thread?.resolved ?? false,
      resolved_by: thread?.resolvedBy ?? null,
      commits_after: commitsAfter,
      followups:
        anchor === null || pull.mergedAt === null
          ? []
          : await followUpFixes(client, candidate.repository, {
              branchCommits,
              pull,
              pullCommits,
              path: comment.path,
              anchor,
            }),
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
      const comment = { bot: candidate.bot, body: candidate.comment.body }
      return labelComment(found, comment).label === 'excluded'
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
      description: candidate.pull.body ?? '',
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

// Follow-up fixes (label-rules-v2): commits on the base branch within about 7 days after
// the merge that change the commented lines. The first hour after the merge is skipped, so
// the merge itself (a squash commit, or a rebased commit carrying a new sha) is never read
// as a follow-up; the PR's own commits are excluded explicitly as well. The anchor's line
// numbers are those of the pull request's head, which the base branch shares right after
// the merge; drift within the window is an accepted approximation.
const FOLLOWUP_WINDOW_DAYS = 7
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// The first hour after the merge is skipped, so the merge itself is never read as a follow-up.
const FOLLOWUP_GRACE_MS = HOUR

async function followUpFixes(
  client: GitHubClient,
  repository: string,
  options: {
    branchCommits: Map<string, { sha: string; subject: string; date: string }[]>
    pull: ReplayPull
    pullCommits: LaterCommit[]
    path: string
    anchor: { start: number; end: number }
  },
): Promise<LaterCommit[]> {
  const { pull, path, anchor } = options
  const merged = Date.parse(pull.mergedAt ?? '')
  if (Number.isNaN(merged)) return []
  const since = new Date(merged + FOLLOWUP_GRACE_MS).toISOString()
  const until = new Date(merged + FOLLOWUP_WINDOW_DAYS * DAY).toISOString()
  const key = `${repository}:${pull.baseRef}:${path}:${since}:${until}`
  if (!options.branchCommits.has(key))
    options.branchCommits.set(
      key,
      await fetchBranchCommits(client, repository, { ref: pull.baseRef, path, since, until }),
    )
  const own = new Set([...options.pullCommits.map((commit) => commit.sha), pull.mergeCommitSha])
  const fixes: LaterCommit[] = []
  for (const commit of options.branchCommits.get(key) ?? []) {
    if (own.has(commit.sha)) continue
    const files = await fetchCommitFiles(client, repository, commit.sha)
    const file = files?.find((entry) => entry.filename === path || entry.previous_filename === path)
    if (file?.patch !== undefined && isChangedAt(file.patch, anchor))
      fixes.push({ sha: commit.sha, subject: commit.subject })
  }
  return fixes
}

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

// Bot summaries and walkthroughs posted as inline comments, by their known markers, plus
// comments about the pull request's title and description (Gemini's block), which review
// the pull request's metadata rather than its code (label-rules-v2).
const SUMMARY_MARKERS = [
  /<!--\s*walkthrough_start\s*-->/i,
  /<!--\s*This is an auto-generated comment: summarize by coderabbit\.ai\s*-->/i,
  /^#{1,3}\s*Walkthrough\b/im,
  /^#{1,3}\s*Pull Request Overview\b/im,
  /^#{1,3}\s*Greptile Summary\b/im,
  /<h3>\s*Greptile Summary\s*<\/h3>/i,
  /\bPull Request Title and Summary\b/i,
  /^\s*\*{0,2}Suggested PR (?:Title|Summary)\*{0,2}:\s*$/m,
]

// GitHub titles a generated revert pull request `Revert "..."`; such a PR restores old
// code instead of accepting review, so its comments are not eligible (label-rules-v2).
function isRevertPull(title: string): boolean {
  return /^revert\b/i.test(title)
}

// Eligibility (spec 10.4): a thread-root inline comment by a configured bot, on a PR merged
// inside the window, with a diff hunk and a line anchor, that is not a bot summary and not
// on a pure revert PR.
function eligibleComments(pull: ReplayPull, config: ReplayConfig): EligibleComment[] {
  if (isRevertPull(pull.title)) return []
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
