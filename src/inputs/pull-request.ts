import { validationError } from '../errors.js'
import { cleanBody, hunkTail, type Item } from '../core/items.js'
import { gitHubError, type GitHubClient } from './github.js'

export interface PullRequestRef {
  owner: string
  repo: string
  number: number
}

export type AuthorFilter = 'bots' | 'humans' | 'all'

export interface PullRequestData {
  isPrivate: boolean
  title: string
  comments: ReviewComment[]
}

export interface ReviewComment {
  id: number
  user: { login: string; type?: string } | null
  body: string
  path: string
  line: number | null
  start_line: number | null
  original_line: number | null
  original_start_line: number | null
  diff_hunk: string
  created_at: string
  in_reply_to_id?: number | null
  html_url: string
}

// Accepts https://github.com/<owner>/<repo>/pull/<n>[/...] and <owner>/<repo>#<n> (spec 4.4).
export function parsePullRequestRef(input: string): PullRequestRef {
  const full = input.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/)
  const short = input.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  const match = full ?? short
  if (!match)
    throw validationError(`Not a pull request URL: ${input}`, [
      'Run `quiet-review-axi score https://github.com/<owner>/<repo>/pull/<n>`',
      'Or use the short form `<owner>/<repo>#<n>`',
    ])
  return { owner: match[1] ?? '', repo: match[2] ?? '', number: Number(match[3]) }
}

export function formatRef(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

export async function fetchPullRequest(
  client: GitHubClient,
  ref: PullRequestRef,
): Promise<PullRequestData> {
  const what = formatRef(ref)
  try {
    const repository = await client.rest.repos.get({ owner: ref.owner, repo: ref.repo })
    const pull = await client.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    })
    const comments = await client.paginate(client.rest.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    })
    return {
      isPrivate: repository.data.private,
      title: pull.data.title,
      comments: comments as unknown as ReviewComment[],
    }
  } catch (error) {
    throw gitHubError(error, what)
  }
}

export function isBot(user: ReviewComment['user']): boolean {
  return user?.type === 'Bot' || (user?.login ?? '').endsWith('[bot]')
}

// Thread roots only, in creation order (then comment id), numbered c1, c2, ... before the
// author filter, so ids stay stable for a given pull request (spec 4.4, R17).
export function normalizeComments(comments: ReviewComment[], authors: AuthorFilter): Item[] {
  return comments
    .filter((comment) => comment.in_reply_to_id === undefined || comment.in_reply_to_id === null)
    .sort((a, b) => compare(a.created_at, b.created_at) || a.id - b.id)
    .map((comment, index) => ({ comment, key: `c${index + 1}` }))
    .filter(({ comment }) => authors === 'all' || isBot(comment.user) === (authors === 'bots'))
    .map(({ comment, key }): Item => {
      const line = comment.line ?? comment.original_line
      const start = comment.line === null ? comment.original_start_line : comment.start_line
      return {
        key,
        id: key,
        body: cleanBody(comment.body),
        code: hunkTail(comment.diff_hunk),
        context: 'hunk',
        path: comment.path,
        line,
        lines: lineRange(start, line),
        author: comment.user?.login ?? null,
        url: comment.html_url,
      }
    })
}

function lineRange(start: number | null, end: number | null): string | null {
  if (end === null) return null
  return start !== null && start !== end ? `${start}-${end}` : String(end)
}

function compare(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
