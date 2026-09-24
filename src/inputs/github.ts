import { Octokit } from '@octokit/rest'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { QuietReviewError } from '../errors.js'
import type { FetchLike } from '../jev/provider.js'

export interface GitHubToken {
  token: string
  source: 'env GITHUB_TOKEN' | 'env GH_TOKEN' | 'gh auth token'
}

const TOKEN_HELP = [
  'Set `GITHUB_TOKEN` to a token with read access to the repository',
  'Or set `GH_TOKEN`',
  'Or run `gh auth login` so `gh auth token` can supply one',
]

// Token lookup order (spec 8.2): GITHUB_TOKEN, GH_TOKEN, then `gh auth token`.
export async function findGitHubToken(
  env: Record<string, string | undefined>,
  runGhAuthToken: () => Promise<string | undefined>,
): Promise<GitHubToken | null> {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'env GITHUB_TOKEN' }
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: 'env GH_TOKEN' }
  const token = await runGhAuthToken()
  return token ? { token, source: 'gh auth token' } : null
}

export async function requireGitHubToken(
  env: Record<string, string | undefined>,
  runGhAuthToken: () => Promise<string | undefined>,
): Promise<GitHubToken> {
  const found = await findGitHubToken(env, runGhAuthToken)
  if (!found)
    throw new QuietReviewError('MISSING_GITHUB_TOKEN', 'No GitHub token found', TOKEN_HELP)
  return found
}

const ReadOnlyOctokit = Octokit.plugin(throttling, retry)

// Stands in for one of the throttling plugin's Bottleneck groups (its `throttle.search` and
// `throttle.write` options), implementing only the `key().schedule()` call the plugin makes: runs jobs at once.
const UNPACED_GROUP = {
  key: () => ({
    schedule: <T>(_options: unknown, job: (...args: unknown[]) => T, ...args: unknown[]) =>
      Promise.resolve(job(...args)),
  }),
} as unknown as NonNullable<ThrottlingGroup>

type ThrottlingGroup = NonNullable<
  ConstructorParameters<typeof ReadOnlyOctokit>[0]
>['throttle'] extends infer T
  ? T extends { search?: infer G }
    ? G
    : never
  : never

export type GitHubClient = InstanceType<typeof ReadOnlyOctokit>

// Octokit wrapped so it can only read (spec 8.1): any REST method other than GET, and any
// GraphQL document containing a mutation, throws before a request is sent.
// With `callerPacesSearch`, the throttling plugin's 2 s search spacing is switched off because
// the caller's fetch paces the search requests that reach the network (replay, spec 8.1).
// The plugin's 1 s write spacing is always off: this client never writes, and GraphQL reads
// are POSTs the plugin would otherwise count as writes.
export function createGitHubClient(options: {
  token: string
  fetch: FetchLike
  callerPacesSearch?: boolean
}): GitHubClient {
  const octokit = new ReadOnlyOctokit({
    auth: options.token,
    request: { fetch: options.fetch },
    throttle: {
      write: UNPACED_GROUP,
      ...(options.callerPacesSearch ? { search: UNPACED_GROUP } : {}),
      onRateLimit: (retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
        retryCount < 1 && retryAfter <= 60,
      onSecondaryRateLimit: (
        retryAfter: number,
        _options: unknown,
        _octokit: unknown,
        retryCount: number,
      ) => retryCount < 1 && retryAfter <= 60,
    },
    retry: { doNotRetry: [400, 401, 403, 404, 410, 422, 451] },
  })
  octokit.hook.before('request', (request) => {
    const method = String(request.method).toUpperCase()
    const isGraphql = String(request.url) === '/graphql'
    if (isGraphql && /\bmutation\b/.test(String((request as { query?: unknown }).query ?? ''))) {
      throw new Error('Quiet Review is read-only on GitHub: GraphQL mutations are refused')
    }
    if (!isGraphql && method !== 'GET')
      throw new Error(`Quiet Review is read-only on GitHub: ${method} requests are refused`)
  })
  return octokit
}

// Maps Octokit failures to stable error codes (spec 4.2). Never includes the token.
export function gitHubError(error: unknown, what: string): QuietReviewError {
  if (error instanceof QuietReviewError) return error
  const status = (error as { status?: number }).status
  const headers = ((error as { response?: { headers?: Record<string, string> } }).response
    ?.headers ?? {}) as Record<string, string>
  if (status === 401)
    return new QuietReviewError(
      'GITHUB_AUTH',
      `GitHub rejected the token while reading ${what}`,
      TOKEN_HELP,
    )
  if (status === 404)
    return new QuietReviewError(
      'GITHUB_NOT_FOUND',
      `${what} does not exist or is not visible to the token`,
      ['Check the pull request URL', 'Use a token that can read the repository'],
    )
  if (status === 429 || (status === 403 && headers['x-ratelimit-remaining'] === '0'))
    return new QuietReviewError(
      'GITHUB_RATE_LIMIT',
      `GitHub rate limit reached while reading ${what}`,
      ['Wait for the rate limit to reset, then run the command again'],
    )
  if (status === 403)
    return new QuietReviewError('GITHUB_AUTH', `GitHub refused access to ${what}`, TOKEN_HELP)
  const message = error instanceof Error ? error.message : String(error)
  return new QuietReviewError('GITHUB_ERROR', `GitHub request for ${what} failed: ${message}`)
}
