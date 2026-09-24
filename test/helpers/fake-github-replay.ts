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
}

export interface FakeCompareFile {
  filename: string
  status: string
  patch?: string
  additions?: number
  deletions?: number
  previous_filename?: string
}

export interface FakeReplayWorld {
  repositories: FakeRepository[]
  pulls: FakePull[]
  // Compare results keyed by `owner/repo:from...to`; missing entries answer 404.
  compares?: Record<string, { merge_base?: string; files: FakeCompareFile[] }>
  // File contents keyed by `owner/repo:path@ref`.
  contents?: Record<string, string>
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
    const pullMatch = rest.match(/^\/pulls\/(\d+)(\/comments)?$/)
    if (pullMatch) {
      const pull = world.pulls.find(
        (candidate) =>
          candidate.repository === fullName && candidate.number === Number(pullMatch[1]),
      )
      if (!pull) return notFound()
      if (pullMatch[2]) return page(parsed, pull.comments.map(commentJson(pull)))
      return jsonResponse(200, pullJson(pull))
    }
    const compareMatch = rest.match(/^\/compare\/(.+)$/)
    if (compareMatch) {
      const compare = world.compares?.[`${fullName}:${compareMatch[1]}`]
      if (!compare) return notFound()
      const [from] = (compareMatch[1] ?? '').split('...')
      return jsonResponse(200, {
        merge_base_commit: { sha: compare.merge_base ?? from },
        files: compare.files.map((file) => ({ additions: 0, deletions: 0, ...file })),
      })
    }
    const contentsMatch = rest.match(/^\/contents\/(.+)$/)
    if (contentsMatch) {
      const text =
        world.contents?.[`${fullName}:${contentsMatch[1]}@${parsed.searchParams.get('ref')}`]
      if (text === undefined) return notFound()
      return jsonResponse(200, {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(text, 'utf8').toString('base64'),
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

  function graphql(request: { variables?: Record<string, unknown> }) {
    const { owner, repo, number } = request.variables ?? {}
    const pull = world.pulls.find(
      (candidate) => candidate.repository === `${owner}/${repo}` && candidate.number === number,
    )
    if (!pull) return jsonResponse(200, { data: { repository: { pullRequest: null } } })
    const nodes = pull.comments
      .filter((comment) => comment.in_reply_to_id === undefined)
      .map((comment) => ({
        isResolved: pull.resolved?.[comment.id] ?? false,
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
