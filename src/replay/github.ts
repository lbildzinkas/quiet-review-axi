import { gitHubError, type GitHubClient } from '../inputs/github.js'
import type { ReviewComment } from '../inputs/pull-request.js'
import type { ReplayConfig } from './config.js'
import type { RepositoryMeta } from './select.js'

// GitHub reads for `replay build` (spec 8.1, 10.3-10.5). All read-only.

export interface ReplayComment extends ReviewComment {
  side?: 'LEFT' | 'RIGHT' | null
  original_commit_id: string
}

export interface ReplayPull {
  repository: string
  number: number
  title: string
  mergedAt: string | null
  headSha: string
  comments: ReplayComment[]
}

export interface CompareFile {
  filename: string
  status: string
  patch?: string
  additions: number
  deletions: number
  previous_filename?: string
}

export interface CompareResult {
  mergeBase: string
  files: CompareFile[]
}

// GitHub returns at most 300 files in a comparison; a longer list may be missing ours.
export const MAX_COMPARE_FILES = 300

type Window = ReplayConfig['window']

// The search qualifier for comments by a login; GitHub Apps are searched as `app/<slug>`.
export function commenterQualifier(login: string): string {
  return login.endsWith('[bot]') ? `app/${login.slice(0, -'[bot]'.length)}` : login
}

// `merged:A..B` is inclusive, while the window's merged_before is exclusive.
export function mergedQualifier(window: Window): string {
  const last = new Date(`${window.merged_before}T00:00:00Z`)
  last.setUTCDate(last.getUTCDate() - 1)
  return `merged:${window.merged_after}..${last.toISOString().slice(0, 10)}`
}

export interface SearchHit {
  repository: string
  number: number
  title: string
}

export async function searchMergedPulls(
  client: GitHubClient,
  options: { window: Window; repository?: string; commenter?: string },
): Promise<SearchHit[]> {
  const q = searchQuery(options)
  try {
    const items = await client.paginate('GET /search/issues', { q, per_page: 100 })
    return (items as { number: number; title: string; repository_url: string }[]).map((item) => ({
      repository: item.repository_url.replace(/^.*\/repos\//, ''),
      number: item.number,
      title: item.title,
    }))
  } catch (error) {
    throw gitHubError(error, `the search \`${q}\``)
  }
}

// A repository's metadata (criteria 1 and 5), or null when it is missing or not visible.
export async function fetchRepositoryMeta(
  client: GitHubClient,
  repository: string,
): Promise<RepositoryMeta | null> {
  const [owner = '', repo = ''] = repository.split('/')
  try {
    const { data } = await client.rest.repos.get({ owner, repo })
    return {
      owner: data.owner.login,
      isPrivate: data.private,
      isArchived: data.archived,
      isFork: data.fork,
    }
  } catch (error) {
    if (isMissing(error)) return null
    throw gitHubError(error, repository)
  }
}

// The number of PRs merged in the window, and the titles of up to 100 of them.
export async function countMergedPulls(
  client: GitHubClient,
  repository: string,
  window: Window,
): Promise<{ total: number; titles: string[] }> {
  const q = searchQuery({ window, repository })
  try {
    const { data } = await client.request('GET /search/issues', { q, per_page: 100 })
    return { total: data.total_count, titles: data.items.map((item) => item.title) }
  } catch (error) {
    throw gitHubError(error, `the search \`${q}\``)
  }
}

export async function fetchReplayPull(
  client: GitHubClient,
  repository: string,
  number: number,
): Promise<ReplayPull> {
  const [owner = '', repo = ''] = repository.split('/')
  try {
    const pull = await client.rest.pulls.get({ owner, repo, pull_number: number })
    const comments = await client.paginate(client.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    })
    return {
      repository,
      number,
      title: pull.data.title,
      mergedAt: pull.data.merged_at,
      headSha: pull.data.head.sha,
      comments: comments as unknown as ReplayComment[],
    }
  } catch (error) {
    throw gitHubError(error, `${repository}#${number}`)
  }
}

function searchQuery(options: { window: Window; repository?: string; commenter?: string }) {
  return [
    options.repository === undefined ? null : `repo:${options.repository}`,
    'is:pr',
    'is:merged',
    mergedQualifier(options.window),
    options.commenter === undefined ? null : `commenter:${commenterQualifier(options.commenter)}`,
  ]
    .filter((term) => term !== null)
    .join(' ')
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: { isResolved: boolean; comments: { nodes: { databaseId: number | null }[] } }[]
      }
    } | null
  } | null
}

// Resolution state of every review thread, keyed by the thread's root comment id.
export async function fetchThreadResolution(
  client: GitHubClient,
  repository: string,
  number: number,
): Promise<Map<number, boolean>> {
  const [owner = '', repo = ''] = repository.split('/')
  const resolved = new Map<number, boolean>()
  let cursor: string | null = null
  try {
    for (;;) {
      const page: ThreadsPage = await client.graphql<ThreadsPage>(THREADS_QUERY, {
        owner,
        repo,
        number,
        cursor,
      })
      const threads = page.repository?.pullRequest?.reviewThreads
      if (!threads) return resolved
      for (const thread of threads.nodes) {
        const root = thread.comments.nodes[0]?.databaseId
        if (typeof root === 'number') resolved.set(root, thread.isResolved)
      }
      if (!threads.pageInfo.hasNextPage) return resolved
      cursor = threads.pageInfo.endCursor
    }
  } catch (error) {
    throw gitHubError(error, `the review threads of ${repository}#${number}`)
  }
}

// The comparison between two commits, or null when either commit can no longer be fetched.
export async function fetchCompare(
  client: GitHubClient,
  repository: string,
  from: string,
  to: string,
): Promise<CompareResult | null> {
  const [owner = '', repo = ''] = repository.split('/')
  try {
    const response = await client.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${from}...${to}`,
    })
    return {
      mergeBase: response.data.merge_base_commit.sha,
      files: (response.data.files ?? []) as CompareFile[],
    }
  } catch (error) {
    if (isMissing(error)) return null
    throw gitHubError(error, `the comparison ${from}...${to} in ${repository}`)
  }
}

// The number of lines of a file at a commit, or null when it cannot be read.
export async function fetchFileLines(
  client: GitHubClient,
  repository: string,
  path: string,
  ref: string,
): Promise<number | null> {
  const [owner = '', repo = ''] = repository.split('/')
  try {
    const response = await client.rest.repos.getContent({ owner, repo, path, ref })
    const data = response.data as { type?: string; encoding?: string; content?: string }
    if (data.type !== 'file' || data.encoding !== 'base64' || data.content === undefined)
      return null
    const text = Buffer.from(data.content, 'base64').toString('utf8')
    if (text.length === 0) return 0
    return text.replace(/\n$/, '').split('\n').length
  } catch (error) {
    if (isMissing(error) || isOversized(error)) return null
    throw gitHubError(error, `${path} at ${ref} in ${repository}`)
  }
}

function isMissing(error: unknown): boolean {
  const status = (error as { status?: number }).status
  return status === 404 || status === 422
}

// GitHub refuses the contents endpoint for files larger than 100 MB with 403 `too_large`,
// which is not an access problem: the line count simply cannot be read.
function isOversized(error: unknown): boolean {
  if ((error as { status?: number }).status !== 403) return false
  const data = (error as { response?: { data?: unknown } }).response?.data
  return JSON.stringify(data ?? {}).includes('too_large')
}
