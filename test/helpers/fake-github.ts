import { jsonResponse } from './fake-jev.js'

export interface FakePullRequest {
  repository: Record<string, unknown>
  pull: Record<string, unknown>
  comments: Record<string, unknown>[]
}

export interface FakeGitHubOptions {
  pulls: Record<string, FakePullRequest>
  pageSize?: number
  // Force a status for every request, for error-mapping tests.
  status?: { code: number; headers?: Record<string, string>; body?: unknown }
}

// A read-only stand-in for api.github.com serving recorded pull requests by `owner/repo#n`.
export function createFakeGitHub(options: FakeGitHubOptions) {
  const requests: { method: string; url: string; authorization: string | null }[] = []

  function matches(url: string) {
    return url.startsWith('https://api.github.com/')
  }

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    requests.push({ method, url, authorization: new Headers(init.headers).get('authorization') })
    if (options.status)
      return jsonResponse(
        options.status.code,
        options.status.body ?? { message: 'error' },
        options.status.headers,
      )
    const parsed = new URL(url)
    const match = parsed.pathname.match(
      /^\/repos\/([^/]+)\/([^/]+)(?:\/pulls\/(\d+)(\/comments)?)?$/,
    )
    if (!match || method !== 'GET') return notFound()
    const [, owner, repo, number, comments] = match
    const repository = Object.entries(options.pulls).find(([key]) =>
      key.startsWith(`${owner}/${repo}#`),
    )
    if (!repository) return notFound()
    if (number === undefined) return jsonResponse(200, repository[1].repository)
    const pull = options.pulls[`${owner}/${repo}#${number}`]
    if (!pull) return notFound()
    if (!comments) return jsonResponse(200, pull.pull)
    return page(url, pull.comments)
  }

  function page(url: string, items: unknown[]) {
    const parsed = new URL(url)
    const size = options.pageSize ?? 100
    const current = Number(parsed.searchParams.get('page') ?? '1')
    const slice = items.slice((current - 1) * size, current * size)
    const headers: Record<string, string> = {}
    if (current * size < items.length) {
      parsed.searchParams.set('page', String(current + 1))
      headers.link = `<${parsed.toString()}>; rel="next"`
    }
    return jsonResponse(200, slice, headers)
  }

  return { requests, matches, handle }
}

function notFound() {
  return jsonResponse(404, {
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/rest',
  })
}
