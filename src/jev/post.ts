import { QuietReviewError } from '../errors.js'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface PostOptions {
  apiKey: string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
}

export interface PostTarget {
  // Provider name used in error messages, for example `openrouter`.
  name: string
  endpoint: string
  // The environment variable that holds the key, named in error help.
  keyEnv: string
  // Per-attempt timeout (default 10 s, spec 7).
  timeoutMs?: number
}

// Retry policy modelled on the TypeSafe SDK (spec 7, Jev guide 2.9).
const MAX_RETRIES = 2
const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 5_000
const MAX_RETRY_HINT_MS = 60_000
const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_LOGGED_BODY_CHARACTERS = 2_000

type Attempt =
  | { kind: 'ok'; payload: unknown }
  | { kind: 'retry'; error: QuietReviewError; hintMs: number | null }

// POSTs a JSON body with the provider retry policy and error mapping (spec 7). Used by the
// Jev providers and by the replay's label model, which share OpenRouter's error shapes.
export async function postJson(
  target: PostTarget,
  body: string,
  options: PostOptions,
): Promise<{ payload: unknown; retries: number }> {
  for (let retries = 0; ; retries++) {
    const outcome = await attempt(target, body, options)
    if (outcome.kind === 'ok') return { payload: outcome.payload, retries }
    if (retries >= MAX_RETRIES) throw outcome.error
    await options.sleep(outcome.hintMs ?? backoffMs(retries, options.random))
  }
}

async function attempt(target: PostTarget, body: string, options: PostOptions): Promise<Attempt> {
  const timeoutMs = target.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await options.fetch(target.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    })
    const text = await response.text()
    if (response.ok) return { kind: 'ok', payload: parseJson(text) }
    return classifyFailure(target, response, text)
  } catch (error) {
    if (error instanceof QuietReviewError) throw error
    const message = controller.signal.aborted
      ? `The ${target.name} request timed out after ${timeoutMs / 1000} s`
      : `The ${target.name} request failed: ${error instanceof Error ? error.message : String(error)}`
    return { kind: 'retry', error: new QuietReviewError('PROVIDER_ERROR', message), hintMs: null }
  } finally {
    clearTimeout(timer)
  }
}

function classifyFailure(target: PostTarget, response: Response, text: string): Attempt {
  const status = response.status
  const details = {
    providerStatus: status,
    providerBody: text.slice(0, MAX_LOGGED_BODY_CHARACTERS),
  }
  const hintMs = retryHintMs(response.headers)
  if (status === 401 || status === 403)
    throw new QuietReviewError(
      'PROVIDER_AUTH',
      `${target.name} rejected the API key (HTTP ${status})`,
      [`Check the key in ${target.keyEnv} or in the user config file`],
      details,
    )
  if (status === 402 && limitSource(text) === 'openrouter_in_flight_budget')
    return retryable(
      'PROVIDER_ERROR',
      `${target.name} held the request for its in-flight budget (HTTP 402)`,
      hintMs,
      details,
    )
  if (status === 402)
    throw new QuietReviewError(
      'PROVIDER_CREDITS',
      `${target.name} reports exhausted credits or key limit (HTTP 402)`,
      [`Add credits or raise the key limit for the key in ${target.keyEnv}`],
      details,
    )
  if (status === 429)
    return retryable(
      'PROVIDER_RATE_LIMIT',
      `${target.name} is still rate-limiting requests (HTTP 429)`,
      hintMs,
      details,
    )
  if (status === 408 || status >= 500)
    return retryable('PROVIDER_ERROR', `${target.name} failed with HTTP ${status}`, hintMs, details)
  throw new QuietReviewError(
    'PROVIDER_ERROR',
    `${target.name} rejected the request with HTTP ${status}`,
    [],
    details,
  )
}

function retryable(
  code: 'PROVIDER_ERROR' | 'PROVIDER_RATE_LIMIT',
  message: string,
  hintMs: number | null,
  details: { providerStatus: number; providerBody: string },
): Attempt {
  return { kind: 'retry', error: new QuietReviewError(code, message, [], details), hintMs }
}

function backoffMs(retries: number, random: () => number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** retries, MAX_BACKOFF_MS)
  return base * (1 - random() * 0.25)
}

// `retry-after-ms` wins over `Retry-After`; hints above 60 s fall back to the backoff.
function retryHintMs(headers: Headers): number | null {
  const milliseconds = Number(headers.get('retry-after-ms') ?? Number.NaN)
  const seconds = Number(headers.get('retry-after') ?? Number.NaN)
  const hint = Number.isFinite(milliseconds) ? milliseconds : seconds * 1000
  return Number.isFinite(hint) && hint >= 0 && hint <= MAX_RETRY_HINT_MS ? hint : null
}

function limitSource(text: string): unknown {
  const payload = parseJson(text) as { error?: { metadata?: { limit_source?: unknown } } } | null
  return payload?.error?.metadata?.limit_source
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
