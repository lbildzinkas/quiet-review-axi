import type { FetchLike } from '../jev/provider.js'

// GitHub allows 30 search requests a minute; searches that reach the network are spaced out.
const SEARCH_SPACING_MS = 2000

export interface ReplayFetchOptions {
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

// The fetch behind the replay's GitHub client.
export function createReplayFetch(options: ReplayFetchOptions): FetchLike {
  let lastSearchAt: number | null = null
  return async (url, init) => {
    if (new URL(url).pathname.startsWith('/search/')) {
      const now = options.now().getTime()
      if (lastSearchAt !== null && now - lastSearchAt < SEARCH_SPACING_MS)
        await options.sleep(SEARCH_SPACING_MS - (now - lastSearchAt))
      lastSearchAt = options.now().getTime()
    }
    return options.fetch(url, init)
  }
}
