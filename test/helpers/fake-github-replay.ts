import { jsonResponse } from './fake-jev.js'

export interface FakeRepository {
  full_name: string
  private?: boolean
  archived?: boolean
  fork?: boolean
}

export interface FakeComment {
  id: number
  user: { login: string; type: string }
  body: string
  path: string
  line: number | null
  start_line?: number | null
  original_line: number | null
  original_start_line?: number | null
  side?: 'LEFT' | 'RIGHT'
  diff_hunk: string
  created_at: string
  in_reply_to_id?: number
  original_commit_id: string
}

export interface FakePull {
  repository: string
  number: number
  title: string
  merged_at: string | null
  head_sha: string
  comments: FakeComment[]
  // Resolution state of each review thread, keyed by its root comment id.
  resolved?: Record<number, boolean>
  // Who resolved each review thread (GraphQL `resolvedBy`), keyed by root comment id.
  resolved_by?: Record<number, string>
  // The pull request's body, base branch and merge commit.
  body?: string | null
  base?: string
  base_sha?: string
  merge_commit_sha?: string | null
  // When the pull request was opened, and its body's revisions in time order (the last is
  // the current body); without them the body was never edited.
  created_at?: string
  body_history?: { at: string; body: string }[]
  // Title renames in time order (GraphQL RenamedTitleEvent).
  renames?: { at: string; from: string; to: string }[]
  // Issues linked in the sidebar (ConnectedEvent) or unlinked (DisconnectedEvent).
  connected?: { at: string; issue: number; repository?: string; disconnected?: boolean }[]
  // The pull request's commits, in order (sha and subject).
  commits?: { sha: string; subject: string }[]
  // Commits on the base branch after the merge that touch a file: sha, subject, commit
  // date, the file's path and its patch in that commit.
  followUps?: { sha: string; subject: string; at: string; path: string; patch?: string }[]
}

export interface FakeCompareFile {
  filename: string
  status: string
  patch?: string
  additions?: number
  deletions?: number
  previous_filename?: string
}

export interface FakeIssue {
  repository: string
  number: number
  title: string
  body: string | null
  created_at?: string
  body_history?: { at: string; body: string }[]
  renames?: { at: string; from: string; to: string }[]
}

export interface FakeReplayWorld {
  repositories: FakeRepository[]
  pulls: FakePull[]
  issues?: FakeIssue[]
  // Compare results keyed by `owner/repo:from...to`; missing entries answer 404.
  compares?: Record<string, { merge_base?: string; files: FakeCompareFile[] }>
  // File contents keyed by `owner/repo:path@ref`; a `{ tooLarge }` value answers the 403 the
  // contents endpoint returns for a file larger than 100 MB, in one of its observed shapes:
  // 'code' carries `errors[].code: "too_large"`, 'message' only a human message.
  contents?: Record<string, string | { tooLarge: 'code' | 'message' }>
}

// A read-only stand-in for the GitHub REST search, repository, pull, compare and contents
// endpoints and the GraphQL review-thread query, serving one synthetic world.
export function createFakeGitHubReplay(
  world: FakeReplayWorld,
  options: { pageSize?: number } = {},
) {
  const requests: { method: string; url: string; body?: string }[] = []

  function matches(url: string) {
    return url.startsWith('https://api.github.com/')
  }

  // Real responses carry their URL, which Octokit's pagination reads.
  async function handle(url: string, init: RequestInit): Promise<Response> {
    const response = await route(url, init)
    Object.defineProperty(response, 'url', { value: url })
    return response
  }

  async function route(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body === undefined || init.body === null ? undefined : String(init.body)
    requests.push({ method, url, body })
    const parsed = new URL(url)
    const path = decodeURIComponent(parsed.pathname)
    if (method === 'POST' && path === '/graphql') return graphql(JSON.parse(body ?? '{}'))
    if (method !== 'GET') return notFound()
    if (path === '/search/issues') return search(parsed)
    const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/)
    if (!repoMatch) return notFound()
    const [, owner, name, rest = ''] = repoMatch
    const fullName = `${owner}/${name}`
    const repository = world.repositories.find((repo) => repo.full_name === fullName)
    if (!repository) return notFound()
    if (rest === '') return jsonResponse(200, repositoryJson(repository))
    const pullMatch = rest.match(/^\/pulls\/(\d+)(\/comments|\/commits)?$/)
    if (pullMatch) {
      const pull = world.pulls.find(
        (candidate) =>
          candidate.repository === fullName && candidate.number === Number(pullMatch[1]),
      )
      if (!pull) return notFound()
      if (pullMatch[2] === '/comments') return page(parsed, pull.comments.map(commentJson(pull)))
      if (pullMatch[2] === '/commits')
        return page(
          parsed,
          (pull.commits ?? []).map((commit) => ({
            sha: commit.sha,
            commit: { message: commit.subject },
          })),
        )
      return jsonResponse(200, pullJson(pull))
    }
    const commitListMatch = rest.match(/^\/commits$/)
    if (commitListMatch) return commitList(parsed, fullName)
    const commitMatch = rest.match(/^\/commits\/([0-9a-f]+)$/)
    if (commitMatch) return commitDetail(fullName, commitMatch[1] ?? '')
    const compareMatch = rest.match(/^\/compare\/(.+)$/)
    if (compareMatch) {
      const compare = world.compares?.[`${fullName}:${compareMatch[1]}`]
      if (!compare) {
        // A comparison of a commit with itself is empty, not missing.
        const [base, head] = (compareMatch[1] ?? '').split('...')
        if (base === head) return jsonResponse(200, { merge_base_commit: { sha: base }, files: [] })
        return notFound()
      }
      const [from] = (compareMatch[1] ?? '').split('...')
      return jsonResponse(200, {
        merge_base_commit: { sha: compare.merge_base ?? from },
        files: compare.files.map((file) => ({ additions: 0, deletions: 0, ...file })),
      })
    }
    const contentsMatch = rest.match(/^\/contents\/(.+)$/)
    if (contentsMatch) {
      const contents =
        world.contents?.[`${fullName}:${contentsMatch[1]}@${parsed.searchParams.get('ref')}`]
      if (contents === undefined) return notFound()
      if (typeof contents !== 'string') return tooLarge(contents.tooLarge)
      return jsonResponse(200, {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(contents, 'utf8').toString('base64'),
      })
    }
    return notFound()
  }

  function search(url: URL) {
    const terms = (url.searchParams.get('q') ?? '').split(/\s+/).filter(Boolean)
    const value = (prefix: string) =>
      terms.find((term) => term.startsWith(prefix))?.slice(prefix.length)
    const repo = value('repo:')
    const commenter = value('commenter:')
    const [after, before] = (value('merged:') ?? '..').split('..')
    const login = commenter?.startsWith('app/') ? `${commenter.slice(4)}[bot]` : commenter
    const hits = world.pulls
      .filter((pull) => pull.merged_at !== null)
      .filter((pull) => repo === undefined || pull.repository === repo)
      .filter((pull) => {
        const day = (pull.merged_at ?? '').slice(0, 10)
        return (!after || day >= after) && (!before || day <= before)
      })
      .filter(
        (pull) =>
          login === undefined || pull.comments.some((comment) => comment.user.login === login),
      )
      .sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number)
      .map((pull) => ({
        number: pull.number,
        title: pull.title,
        repository_url: `https://api.github.com/repos/${pull.repository}`,
        pull_request: { merged_at: pull.merged_at },
      }))
    const size = Number(url.searchParams.get('per_page') ?? options.pageSize ?? 30)
    const current = Number(url.searchParams.get('page') ?? '1')
    const headers: Record<string, string> = {}
    if (current * size < hits.length) {
      const next = new URL(url)
      next.searchParams.set('page', String(current + 1))
      headers.link = `<${next.toString()}>; rel="next"`
    }
    return jsonResponse(
      200,
      {
        total_count: hits.length,
        incomplete_results: false,
        items: hits.slice((current - 1) * size, current * size),
      },
      headers,
    )
  }

  function graphql(request: { query?: string; variables?: Record<string, unknown> }) {
    if (request.query?.includes('issueOrPullRequest')) return issueContext(request.variables ?? {})
    if (request.query?.includes('userContentEdits')) return pullContext(request.variables ?? {})
    const { owner, repo, number } = request.variables ?? {}
    const pull = world.pulls.find(
      (candidate) => candidate.repository === `${owner}/${repo}` && candidate.number === number,
    )
    if (!pull) return jsonResponse(200, { data: { repository: { pullRequest: null } } })
    const nodes = pull.comments
      .filter((comment) => comment.in_reply_to_id === undefined)
      .map((comment) => ({
        isResolved: pull.resolved?.[comment.id] ?? false,
        resolvedBy: { login: pull.resolved_by?.[comment.id] ?? null },
        comments: { nodes: [{ databaseId: comment.id }] },
      }))
    return jsonResponse(200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      },
    })
  }

  // The pull request's context at a point in time: its body and edit history, and its title
  // renames and linked issues from the timeline.
  function pullContext(variables: Record<string, unknown>) {
    const { owner, repo, number } = variables
    const pull = world.pulls.find(
      (candidate) => candidate.repository === `${owner}/${repo}` && candidate.number === number,
    )
    if (!pull) return jsonResponse(200, { data: { repository: { pullRequest: null } } })
    const subject = (link: { issue: number; repository?: string }) => {
      const repository = link.repository ?? pull.repository
      const isIssue = (world.issues ?? []).some(
        (issue) => issue.repository === repository && issue.number === link.issue,
      )
      return isIssue
        ? { __typename: 'Issue', number: link.issue, repository: { nameWithOwner: repository } }
        : { __typename: 'PullRequest' }
    }
    const timeline = [
      ...(pull.renames ?? []).map((rename) => ({
        __typename: 'RenamedTitleEvent',
        createdAt: rename.at,
        previousTitle: rename.from,
        currentTitle: rename.to,
      })),
      ...(pull.connected ?? []).map((link) => ({
        __typename: link.disconnected ? 'DisconnectedEvent' : 'ConnectedEvent',
        createdAt: link.at,
        subject: subject(link),
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return jsonResponse(200, {
      data: {
        repository: {
          pullRequest: {
            title: pull.title,
            body: currentBody(pull),
            userContentEdits: edits(pull.body_history),
            timelineItems: { totalCount: timeline.length, nodes: timeline },
          },
        },
      },
    })
  }

  function issueContext(variables: Record<string, unknown>) {
    const { owner, repo, number } = variables
    const issue = (world.issues ?? []).find(
      (candidate) => candidate.repository === `${owner}/${repo}` && candidate.number === number,
    )
    const isPull = world.pulls.some(
      (pull) => pull.repository === `${owner}/${repo}` && pull.number === number,
    )
    if (isPull)
      return jsonResponse(200, {
        data: { repository: { issueOrPullRequest: { __typename: 'PullRequest' } } },
      })
    // GitHub answers a missing number with a null field and a NOT_FOUND error.
    if (!issue)
      return jsonResponse(200, {
        data: { repository: { issueOrPullRequest: null } },
        errors: [
          {
            type: 'NOT_FOUND',
            path: ['repository', 'issueOrPullRequest'],
            message: `Could not resolve to an issue or pull request with the number of ${String(number)}.`,
          },
        ],
      })
    const renames = (issue.renames ?? []).map((rename) => ({
      __typename: 'RenamedTitleEvent',
      createdAt: rename.at,
      previousTitle: rename.from,
      currentTitle: rename.to,
    }))
    return jsonResponse(200, {
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: 'Issue',
            title: issue.title,
            body: currentBody(issue),
            createdAt: issue.created_at ?? '2026-01-01T00:00:00Z',
            userContentEdits: edits(issue.body_history),
            timelineItems: { totalCount: renames.length, nodes: renames },
          },
        },
      },
    })
  }

  // The base-branch commit list (`sha`, `path`, `since`, `until`), serving the world's
  // follow-up commits whose date falls in the window.
  function commitList(url: URL, repository: string) {
    const path = url.searchParams.get('path') ?? undefined
    const since = url.searchParams.get('since')
    const until = url.searchParams.get('until')
    const all = world.pulls
      .filter((pull) => pull.repository === repository)
      .flatMap((pull) => pull.followUps ?? [])
    const seen = new Set<string>()
    const hits = all
      .filter((commit) => !seen.has(commit.sha) && seen.add(commit.sha))
      .filter((commit) => path === undefined || commit.path === path)
      .filter((commit) => since === null || since === undefined || commit.at >= since)
      .filter((commit) => until === null || until === undefined || commit.at <= until)
      .map((commit) => ({
        sha: commit.sha,
        commit: { message: commit.subject, committer: { date: commit.at } },
      }))
    return jsonResponse(200, hits)
  }

  function commitDetail(repository: string, sha: string) {
    const commit = world.pulls
      .filter((pull) => pull.repository === repository)
      .flatMap((pull) => pull.followUps ?? [])
      .find((candidate) => candidate.sha === sha)
    if (!commit) return notFound()
    return jsonResponse(200, {
      sha: commit.sha,
      commit: { message: commit.subject, committer: { date: commit.at } },
      files: [
        {
          filename: commit.path,
          status: 'modified',
          additions: 1,
          deletions: 1,
          ...(commit.patch === undefined ? {} : { patch: commit.patch }),
        },
      ],
    })
  }

  function page(url: URL, items: unknown[]) {
    const size = options.pageSize ?? 100
    const current = Number(url.searchParams.get('page') ?? '1')
    const headers: Record<string, string> = {}
    if (current * size < items.length) {
      const next = new URL(url)
      next.searchParams.set('page', String(current + 1))
      headers.link = `<${next.toString()}>; rel="next"`
    }
    return jsonResponse(200, items.slice((current - 1) * size, current * size), headers)
  }

  return { requests, matches, handle }
}

function currentBody(entry: { body?: string | null; body_history?: { body: string }[] }) {
  return entry.body_history?.at(-1)?.body ?? entry.body ?? null
}

// GitHub lists a body's revisions newest first, each with its full text in `diff`; the oldest
// is the original body. A body never edited has no revisions.
function edits(history: { at: string; body: string }[] | undefined) {
  const nodes = [...(history ?? [])]
    .reverse()
    .map((revision) => ({ editedAt: revision.at, diff: revision.body }))
  return { totalCount: nodes.length, nodes }
}

function repositoryJson(repository: FakeRepository) {
  const [owner] = repository.full_name.split('/')
  return {
    full_name: repository.full_name,
    owner: { login: owner },
    private: repository.private ?? false,
    visibility: repository.private ? 'private' : 'public',
    archived: repository.archived ?? false,
    fork: repository.fork ?? false,
  }
}

function pullJson(pull: FakePull) {
  return {
    number: pull.number,
    title: pull.title,
    state: 'closed',
    merged_at: pull.merged_at,
    body: pull.body ?? null,
    base: { ref: pull.base ?? 'main', sha: pull.base_sha ?? `base-${pull.number}` },
    merge_commit_sha: pull.merge_commit_sha ?? null,
    head: { sha: pull.head_sha },
    html_url: `https://github.com/${pull.repository}/pull/${pull.number}`,
  }
}

function commentJson(pull: FakePull) {
  return (comment: FakeComment) => ({
    id: comment.id,
    user: comment.user,
    body: comment.body,
    path: comment.path,
    line: comment.line,
    start_line: comment.start_line ?? null,
    original_line: comment.original_line,
    original_start_line: comment.original_start_line ?? null,
    side: comment.side ?? 'RIGHT',
    diff_hunk: comment.diff_hunk,
    created_at: comment.created_at,
    in_reply_to_id: comment.in_reply_to_id,
    commit_id: pull.head_sha,
    original_commit_id: comment.original_commit_id,
    html_url: `https://github.com/${pull.repository}/pull/${pull.number}#discussion_r${comment.id}`,
  })
}

function notFound() {
  return jsonResponse(404, {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest',
  })
}

function tooLarge(shape: 'code' | 'message') {
  const message =
    shape === 'code'
      ? 'The contents of this file cannot be returned'
      : 'This file is too large to display'
  return jsonResponse(403, {
    message,
    documentation_url: 'https://docs.github.com/rest/repos/contents#get-repository-content',
    status: '403',
    ...(shape === 'code' ? { errors: [{ resource: 'Core', code: 'too_large', message }] } : {}),
  })
}
