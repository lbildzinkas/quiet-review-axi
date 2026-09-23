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

interface ProviderDefinition {
  name: ProviderName
  model: string
  endpoint: string
  keyEnv: string
  extraBody: Record<string, unknown>
  reportsCost: boolean
}

export function defineProvider(definition: ProviderDefinition): JevProvider {
  function buildBody(request: JevQuestions) {
    return {
      model: definition.model,
      state: request.state,
      questions: request.questions,
      ...definition.extraBody,
    }
  }

  async function decide(request: JevQuestions, options: DecideOptions): Promise<JevResult> {
    const response = await options.fetch(definition.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildBody(request)),
    })
    const parsed = validateResponse(await response.json(), Object.keys(request.questions))
    const reported = definition.reportsCost ? parsed.response.usage.cost : undefined
    return {
      ...parsed,
      costUsd: reported ?? parsed.inputTokens * JEV_PRICE_PER_INPUT_TOKEN,
      costSource: reported === undefined ? 'computed' : 'reported',
      retries: 0,
    }
  }

  return { ...definition, buildBody, decide }
}

export function validateResponse(payload: unknown, questionIds: string[]) {
  const parsed = responseSchema.safeParse(payload)
  if (!parsed.success) throw invalidResponse('the response does not match the Jev response shape')
  const answers: Record<string, Answer> = {}
  for (const id of questionIds) {
    const answer = answerSchema.safeParse(parsed.data.answers[id])
    if (!answer.success) throw invalidResponse(`answer ${id} is missing or malformed`)
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
