import { z } from 'zod'
import { QuietReviewError, validationError } from '../errors.js'
import type { Budget } from '../infra/budget.js'
import { cacheKey, readCacheEntry, writeCacheEntry } from '../infra/cache.js'
import { appendCallLog, type CallLogLine } from '../infra/call-log.js'
import { postJson, type FetchLike } from '../jev/post.js'
import {
  LABEL_PROMPT_VERSION,
  buildLabelRequest,
  parseLabelAnswer,
  type AiLabel,
  type ChatBody,
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
  readable: boolean
}

export interface LabelModelOptions {
  sample: LabelledItem[]
  // Shared by every paid call of the invocation (spec 9.4).
  budget: Budget
  model: string
  runId: string
  callLogPath: string
  redact: (text: string) => string
  progress: (line: string) => void
  useCache: boolean
  cacheDir: string
  apiKey: () => string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => Date
}

export interface LabelModelOutcome {
  answers: AiAnswer[]
  // Items left without an answer because the next paid call could have passed --max-cost.
  unlabelled: string[]
}

// Asks the label model about each sampled item in order, from the cache when it can, and
// pays for a call only while its padded estimate fits the budget. After a stop, cache hits
// are still served. Every attempt, cache hits included, is logged without any text (spec 9.3).
export async function runLabelModel(options: LabelModelOptions): Promise<LabelModelOutcome> {
  const answers: AiAnswer[] = []
  const unlabelled: string[] = []
  let pricing: Pricing | null = null
  options.progress(`check: asking ${options.model} about ${options.sample.length} sampled comments`)
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
    if (unlabelled.length > 0 || !options.budget.hasRoom()) {
      unlabelled.push(item.id)
      continue
    }
    pricing ??= await fetchPricing(options)
    if (!options.budget.canAffordUsd(estimateCostUsd(body, pricing))) {
      unlabelled.push(item.id)
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
    const reported = response.usage.cost ?? undefined
    const costUsd = reported ?? observedCostUsd(response, pricing)
    const costSource = reported === undefined ? 'computed' : 'reported'
    options.budget.spend(costUsd)
    await writeCacheEntry(options.cacheDir, key, {
      response,
      cachedAt: options.now().toISOString(),
      latencyMs,
      costUsd,
      costSource,
    })
    answers.push(toAnswer(item.id, response, costUsd))
    await log(options, {
      ...baseLine,
      ...usageFields(response),
      cost_usd: costUsd,
      cost_source: costSource,
      cached: false,
      latency_ms: latencyMs,
      status: 'ok',
    })
  }
  return { answers, unlabelled }
}

// The label model's prices, USD per token, from OpenRouter's public model list.
export const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'

interface Pricing {
  prompt: number
  completion: number
  request: number
}

// Prices are strings of USD per token; router models list "-1" for a variable price, so each
// entry is read loosely and only the label model's own prices must be fixed.
const modelsSchema = z.object({
  data: z.array(
    z.object({ id: z.unknown(), pricing: z.record(z.string(), z.unknown()).optional() }),
  ),
})

async function fetchPricing(options: LabelModelOptions): Promise<Pricing> {
  const listed = await fetchModelList(options.fetch)
  const entry = listed.find((model) => model.id === options.model)
  if (!entry)
    throw validationError(
      `The label model ${options.model} in label_check.model is not a model OpenRouter lists`,
      [FROZEN_CONFIG_HELP],
    )
  // A listed price is a fixed number of USD per token; an absent field or "-1" (variable)
  // is no fixed price, and only the request fee may default to free when the list omits it.
  const fixed = (field: string) => {
    const listed = entry.pricing?.[field]
    if (listed === undefined || listed === null) return null
    const price = Number(listed)
    return Number.isFinite(price) && price >= 0 ? price : null
  }
  const prompt = fixed('prompt')
  const completion = fixed('completion')
  if (prompt === null || completion === null)
    throw validationError(
      `The label model ${options.model} has no fixed per-token price, so --max-cost cannot bound its calls`,
      [FROZEN_CONFIG_HELP],
    )
  return { prompt, completion, request: fixed('request') ?? 0 }
}

const FROZEN_CONFIG_HELP =
  'The replay config is frozen once build has run: put a listed, fixed-price model id in a config with a new replay name'

async function fetchModelList(fetch: FetchLike) {
  let status = 0
  try {
    const response = await fetch(MODELS_ENDPOINT, { method: 'GET' })
    status = response.status
    const parsed = response.ok ? modelsSchema.safeParse(await response.json()) : null
    if (parsed?.success) return parsed.data.data
  } catch {
    // Reported below with the other failures to read the list.
  }
  throw new QuietReviewError(
    'PROVIDER_ERROR',
    `Could not read OpenRouter's model list${status === 0 ? '' : ` (HTTP ${status})`}`,
  )
}

// A call's cost before it is made: its prompt tokens estimated like Jev requests
// (characters / 3.5, spec 5.2), plus the most output the request allows.
function estimateCostUsd(body: ChatBody, pricing: Pricing): number {
  const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 3.5)
  return promptTokens * pricing.prompt + body.max_tokens * pricing.completion + pricing.request
}

function observedCostUsd(response: ChatResponse, pricing: Pricing): number {
  const { usage } = response
  return (
    usage.prompt_tokens * pricing.prompt +
    usage.completion_tokens * pricing.completion +
    pricing.request
  )
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
