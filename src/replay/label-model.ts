import { z } from 'zod'
import { QuietReviewError } from '../errors.js'
import { cacheKey, readCacheEntry, writeCacheEntry } from '../infra/cache.js'
import { appendCallLog, type CallLogLine } from '../infra/call-log.js'
import { postJson, type FetchLike } from '../jev/post.js'
import {
  LABEL_PROMPT_VERSION,
  buildLabelRequest,
  parseLabelAnswer,
  type AiLabel,
  type LabelledItem,
} from './label-check.js'

// The label model is called through OpenRouter's chat API (spec 10.6).
export const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const PROVIDER = 'openrouter'
const KEY_ENV = 'OPENROUTER_API_KEY'
// Chat answers take longer than Jev decisions.
const CHAT_TIMEOUT_MS = 120_000

const chatResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost: z.number().nullable().optional(),
  }),
})

type ChatResponse = z.infer<typeof chatResponseSchema>

export interface AiAnswer {
  id: string
  label: AiLabel
  reason: string
  // The model snapshot that answered and what the answer cost when it was paid for.
  model: string
  cost_usd: number
}

export interface LabelModelOptions {
  sample: LabelledItem[]
  model: string
  runId: string
  callLogPath: string
  redact: (text: string) => string
  useCache: boolean
  cacheDir: string
  apiKey: () => string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => Date
}

// Asks the label model about each sampled item in order, from the cache when it can. Every
// attempt, cache hits included, is logged without any text (spec 9.3).
export async function runLabelModel(options: LabelModelOptions): Promise<AiAnswer[]> {
  const answers: AiAnswer[] = []
  for (const { item } of options.sample) {
    const body = buildLabelRequest(item, options.model)
    const key = cacheKey({ provider: PROVIDER, endpoint: CHAT_ENDPOINT, body })
    const baseLine = {
      run: options.runId,
      command: 'replay',
      provider: PROVIDER,
      model: options.model,
      prompt: LABEL_PROMPT_VERSION,
      request_hash: key,
      items: 1,
    }
    const cached = options.useCache ? await readCached(options.cacheDir, key) : null
    if (cached) {
      answers.push(toAnswer(item.id, cached.response, cached.costUsd))
      await log(options, {
        ...baseLine,
        ...usageFields(cached.response),
        cost_usd: 0,
        cost_source: cached.costSource,
        cached: true,
        latency_ms: 0,
        status: 'ok',
      })
      continue
    }
    const started = performance.now()
    let response: ChatResponse
    try {
      const { payload } = await postJson(
        { name: PROVIDER, endpoint: CHAT_ENDPOINT, keyEnv: KEY_ENV, timeoutMs: CHAT_TIMEOUT_MS },
        JSON.stringify(body),
        {
          apiKey: options.apiKey(),
          fetch: options.fetch,
          sleep: options.sleep,
          random: options.random,
        },
      )
      response = validateChatResponse(payload)
    } catch (error) {
      if (error instanceof QuietReviewError && error.code !== 'MISSING_KEY')
        await log(options, { ...baseLine, ...failureFields(error, options.redact) })
      throw error
    }
    const latencyMs = Math.round(performance.now() - started)
    const costUsd = response.usage.cost ?? 0
    await writeCacheEntry(options.cacheDir, key, {
      response,
      cachedAt: options.now().toISOString(),
      latencyMs,
      costUsd,
      costSource: 'reported',
    })
    answers.push(toAnswer(item.id, response, costUsd))
    await log(options, {
      ...baseLine,
      ...usageFields(response),
      cost_usd: costUsd,
      cost_source: 'reported',
      cached: false,
      latency_ms: latencyMs,
      status: 'ok',
    })
  }
  return answers
}

function usageFields(response: ChatResponse) {
  return {
    snapshot: response.model,
    response_id: response.id ?? null,
    input_tokens: response.usage.prompt_tokens,
    output_tokens: response.usage.completion_tokens,
  }
}

// Provider error bodies can echo request text, so only their start is logged.
const MAX_LOGGED_BODY_CHARACTERS = 500

function failureFields(error: QuietReviewError, redact: (text: string) => string) {
  return {
    snapshot: null,
    response_id: null,
    input_tokens: null,
    cost_usd: 0,
    cost_source: null,
    cached: false,
    latency_ms: null,
    status: 'error' as const,
    error_code: error.code,
    ...(error.providerStatus === undefined ? {} : { http_status: error.providerStatus }),
    ...(error.providerBody === undefined
      ? {}
      : { error_body: redact(error.providerBody).slice(0, MAX_LOGGED_BODY_CHARACTERS) }),
  }
}

async function log(options: LabelModelOptions, line: Omit<CallLogLine, 'ts'>) {
  await appendCallLog(options.callLogPath, { ts: options.now().toISOString(), ...line })
}

async function readCached(dir: string, key: string) {
  const entry = await readCacheEntry<ChatResponse>(dir, key)
  if (!entry) return null
  // An entry that no longer validates is treated as a miss and replaced.
  const parsed = chatResponseSchema.safeParse(entry.response)
  return parsed.success ? { ...entry, response: parsed.data } : null
}

function validateChatResponse(payload: unknown): ChatResponse {
  const parsed = chatResponseSchema.safeParse(payload)
  if (!parsed.success)
    throw new QuietReviewError(
      'INVALID_RESPONSE',
      'The label model returned an invalid response: it does not match the chat completion shape',
    )
  return parsed.data
}

function toAnswer(id: string, response: ChatResponse, costUsd: number): AiAnswer {
  const content = response.choices[0]?.message.content ?? ''
  return { id, ...parseLabelAnswer(content), model: response.model, cost_usd: costUsd }
}
