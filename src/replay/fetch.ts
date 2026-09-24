import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJson } from '../infra/canonical-json.js'
import type { FetchLike } from '../jev/provider.js'
import { readOptional, writeAtomic } from './store.js'

// GitHub allows 30 search requests a minute; searches that reach the network are spaced out.
const SEARCH_SPACING_MS = 2000

// Answers that stay the same on a re-run: found, not found (a commit lost to a force-push),
// and unprocessable (an unknown comparison).
const CACHED_STATUSES = new Set([200, 404, 422])

// Response headers a cached answer needs: pagination and the body type.
const KEPT_HEADERS = ['link', 'content-type']

export interface ReplayFetchOptions {
  cacheDir: string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

interface CachedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

// The fetch behind the replay's GitHub client. Every GitHub answer is cached in the replay
// directory, keyed by method, URL and body (never headers, so never the token): a rebuild
// makes no network calls (spec 8.1).
export function createReplayFetch(options: ReplayFetchOptions): FetchLike {
  let lastSearchAt: number | null = null
  return async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : null
    const path = join(options.cacheDir, `${cacheKey({ method, url, body })}.json`)
    const cached = await readOptional(path)
    if (cached !== null) return toResponse(url, JSON.parse(cached) as CachedResponse)

    if (new URL(url).pathname.startsWith('/search/')) {
      const now = options.now().getTime()
      if (lastSearchAt !== null && now - lastSearchAt < SEARCH_SPACING_MS)
        await options.sleep(SEARCH_SPACING_MS - (now - lastSearchAt))
      lastSearchAt = options.now().getTime()
    }
    const response = await options.fetch(url, init)
    if (!CACHED_STATUSES.has(response.status)) return response
    const entry: CachedResponse = {
      status: response.status,
      headers: Object.fromEntries(
        KEPT_HEADERS.flatMap((name) => {
          const value = response.headers.get(name)
          return value === null ? [] : [[name, value]]
        }),
      ),
      body: await response.text(),
    }
    await writeAtomic(path, JSON.stringify(entry))
    return toResponse(url, entry)
  }
}

function cacheKey(request: { method: string; url: string; body: string | null }): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex')
}

// Octokit's pagination reads the response URL, which a constructed Response lacks.
function toResponse(url: string, entry: CachedResponse): Response {
  const response = new Response(entry.body, { status: entry.status, headers: entry.headers })
  Object.defineProperty(response, 'url', { value: url })
  return response
}
