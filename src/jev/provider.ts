import { QuietReviewError } from '../errors.js'
import type { Question } from '../core/questions.js'
import { answerSchema, responseSchema, type Answer, type JevResponse } from './schema.js'

export type ProviderName = 'openrouter' | 'typesafe'
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface JevQuestions {
  state: unknown
  questions: Record<string, Question>
}

export interface JevResult {
  answers: Record<string, Answer>
  snapshot: string
  responseId?: string
  inputTokens: number
  costUsd: number
  costSource: 'reported' | 'computed'
  retries: number
  response: JevResponse
}

export interface DecideOptions {
  apiKey: string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
}

export interface JevProvider {
  name: ProviderName
  model: string
  endpoint: string
  keyEnv: string
  buildBody(request: JevQuestions): Record<string, unknown>
  decide(request: JevQuestions, options: DecideOptions): Promise<JevResult>
}

// Jev list price: USD per input token; output is free (Jev guide 2.11).
export const JEV_PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000

// Retry policy modelled on the TypeSafe SDK (spec 7, Jev guide 2.9).
const MAX_RETRIES = 2
const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 5_000
const MAX_RETRY_HINT_MS = 60_000
const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_LOGGED_BODY_CHARACTERS = 2_000

interface ProviderDefinition {
  name: ProviderName
  model: string
  endpoint: string
  keyEnv: string
  extraBody: Record<string, unknown>
  reportsCost: boolean
}

type Attempt =
  | { kind: 'ok'; payload: unknown }
  | { kind: 'retry'; error: QuietReviewError; hintMs: number | null }

export function defineProvider(definition: ProviderDefinition): JevProvider {
  function buildBody(request: JevQuestions) {
    return {
      model: definition.model,
      state: request.state,
      questions: request.questions,
      ...definition.extraBody,
    }
  }

  async function attempt(body: string, options: DecideOptions): Promise<Attempt> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
    try {
      const response = await options.fetch(definition.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
      const text = await response.text()
      if (response.ok) return { kind: 'ok', payload: parseJson(text) }
      return classifyFailure(response, text)
    } catch (error) {
      if (error instanceof QuietReviewError) throw error
      const message = controller.signal.aborted
        ? `The ${definition.name} request timed out after ${ATTEMPT_TIMEOUT_MS / 1000} s`
        : `The ${definition.name} request failed: ${error instanceof Error ? error.message : String(error)}`
      return { kind: 'retry', error: new QuietReviewError('PROVIDER_ERROR', message), hintMs: null }
    } finally {
      clearTimeout(timer)
    }
  }

  function classifyFailure(response: Response, text: string): Attempt {
    const status = response.status
    const details = {
      providerStatus: status,
      providerBody: text.slice(0, MAX_LOGGED_BODY_CHARACTERS),
    }
    const hintMs = retryHintMs(response.headers)
    if (status === 401 || status === 403)
      throw new QuietReviewError(
        'PROVIDER_AUTH',
        `${definition.name} rejected the API key (HTTP ${status})`,
        [`Check the key in ${definition.keyEnv} or in the user config file`],
        details,
      )
    if (status === 402 && limitSource(text) === 'openrouter_in_flight_budget')
      return retryable(
        'PROVIDER_ERROR',
        `${definition.name} held the request for its in-flight budget (HTTP 402)`,
        hintMs,
        details,
      )
    if (status === 402)
      throw new QuietReviewError(
        'PROVIDER_CREDITS',
        `${definition.name} reports exhausted credits or key limit (HTTP 402)`,
        [`Add credits or raise the key limit for the key in ${definition.keyEnv}`],
        details,
      )
    if (status === 429)
      return retryable(
        'PROVIDER_RATE_LIMIT',
        `${definition.name} is still rate-limiting requests (HTTP 429)`,
        hintMs,
        details,
      )
    if (status === 408 || status >= 500)
      return retryable(
        'PROVIDER_ERROR',
        `${definition.name} failed with HTTP ${status}`,
        hintMs,
        details,
      )
    throw new QuietReviewError(
      'PROVIDER_ERROR',
      `${definition.name} rejected the request with HTTP ${status}`,
      [],
      details,
    )
  }

  async function decide(request: JevQuestions, options: DecideOptions): Promise<JevResult> {
    const body = JSON.stringify(buildBody(request))
    for (let retries = 0; ; retries++) {
      const outcome = await attempt(body, options)
      if (outcome.kind === 'ok') return toResult(outcome.payload, request, retries)
      if (retries >= MAX_RETRIES) throw outcome.error
      await options.sleep(outcome.hintMs ?? backoffMs(retries, options.random))
    }
  }

  function toResult(payload: unknown, request: JevQuestions, retries: number): JevResult {
    const parsed = validateResponse(payload, request.questions)
    const reported = definition.reportsCost ? parsed.response.usage.cost : undefined
    return {
      ...parsed,
      costUsd: reported ?? parsed.inputTokens * JEV_PRICE_PER_INPUT_TOKEN,
      costSource: reported === undefined ? 'computed' : 'reported',
      retries,
    }
  }

  return { ...definition, buildBody, decide }
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

// Validates a response against the asked questions (spec 5.5); nothing partial is returned.
export function validateResponse(payload: unknown, questions: Record<string, Question>) {
  const parsed = responseSchema.safeParse(payload)
  if (!parsed.success) throw invalidResponse('the response does not match the Jev response shape')
  const answers: Record<string, Answer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = answerSchema.safeParse(parsed.data.answers[id])
    if (!answer.success) throw invalidResponse(`answer ${id} is missing or malformed`)
    if (answer.data.type !== question.type)
      throw invalidResponse(
        `answer ${id} is a ${answer.data.type}, but a ${question.type} was asked`,
      )
    answers[id] = answer.data
  }
  return {
    answers,
    snapshot: parsed.data.model,
    responseId: parsed.data.id,
    inputTokens: parsed.data.usage.input_tokens,
    response: parsed.data,
  }
}

function invalidResponse(detail: string) {
  return new QuietReviewError(
    'INVALID_RESPONSE',
    `The provider returned an invalid response: ${detail}`,
  )
}
