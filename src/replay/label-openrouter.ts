import { z } from 'zod'
import { QuietReviewError, validationError } from '../errors.js'
import { postJson, type FetchLike } from '../jev/post.js'
import { buildLabelRequest, type ChatBody } from './label-check.js'
import type { LabelBackend } from './label-model.js'

// The label model called through OpenRouter's chat API (spec 10.6), paid per call.
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

export interface OpenRouterBackendOptions {
  model: string
  apiKey: () => string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
}

// Each call is estimated from the model's listed prices before it is made and must fit
// --max-cost; its spend is the reported cost, or the observed tokens at the listed prices.
export function openRouterBackend(options: OpenRouterBackendOptions): LabelBackend<ChatResponse> {
  let apiKey: string | null = null
  let pricing: Pricing | null = null
  return {
    provider: PROVIDER,
    model: options.model,
    describe: options.model,
    request: (item) => ({ endpoint: CHAT_ENDPOINT, body: buildLabelRequest(item, options.model) }),
    async fits(request, budget) {
      if (!budget.hasRoom()) return false
      // The key comes first: a run without one fails with MISSING_KEY, not a price lookup.
      apiKey ??= options.apiKey()
      pricing ??= await fetchPricing(options)
      return budget.canAffordUsd(estimateCostUsd(request.body as ChatBody, pricing))
    },
    async call(request) {
      apiKey ??= options.apiKey()
      pricing ??= await fetchPricing(options)
      const { payload } = await postJson(
        { name: PROVIDER, endpoint: CHAT_ENDPOINT, keyEnv: KEY_ENV, timeoutMs: CHAT_TIMEOUT_MS },
        JSON.stringify(request.body),
        { apiKey, fetch: options.fetch, sleep: options.sleep, random: options.random },
      )
      const response = validateChatResponse(payload)
      const reported = response.usage.cost ?? undefined
      return {
        response,
        costUsd: reported ?? observedCostUsd(response, pricing),
        costSource: reported === undefined ? 'computed' : 'reported',
      }
    },
    validate(cached) {
      const parsed = chatResponseSchema.safeParse(cached)
      return parsed.success ? parsed.data : null
    },
    read: (response) => ({
      content: response.choices[0]?.message.content ?? '',
      snapshot: response.model,
      responseId: response.id ?? null,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    }),
  }
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

// What OpenRouter writes for a fixed price: a plain decimal, no exponent or unit.
const DECIMAL = /^-?\d+(?:\.\d+)?$/

async function fetchPricing(options: OpenRouterBackendOptions): Promise<Pricing> {
  const listed = await fetchModelList(options.fetch)
  const entry = listed.find((model) => model.id === options.model)
  if (!entry)
    throw validationError(
      `The label model ${options.model} in label_check.model is not a model OpenRouter lists`,
      [FROZEN_CONFIG_HELP],
    )
  // A listed price is fixed only as a number, or a non-empty string writing a plain decimal
  // of USD, finite and non-negative; "" and "-1" (variable) are no fixed price. The request
  // fee is not per-token but answers to the same rule, and reads as free only when omitted.
  const fixed = (field: string): number | null => {
    const listed = entry.pricing?.[field]
    if (typeof listed === 'number') return Number.isFinite(listed) && listed >= 0 ? listed : null
    if (typeof listed === 'string' && DECIMAL.test(listed.trim())) {
      const price = Number(listed)
      return Number.isFinite(price) && price >= 0 ? price : null
    }
    return null
  }
  const prompt = fixed('prompt')
  const completion = fixed('completion')
  const request = fixed('request')
  const requestListed = entry.pricing?.request !== undefined
  if (prompt === null || completion === null || (requestListed && request === null))
    throw validationError(
      `The label model ${options.model} has no fixed per-token price, so --max-cost cannot bound its calls`,
      [FROZEN_CONFIG_HELP],
    )
  return { prompt, completion, request: request ?? 0 }
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

function validateChatResponse(payload: unknown): ChatResponse {
  const parsed = chatResponseSchema.safeParse(payload)
  if (!parsed.success)
    throw new QuietReviewError(
      'INVALID_RESPONSE',
      'The label model returned an invalid response: it does not match the chat completion shape',
    )
  return parsed.data
}
