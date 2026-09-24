import { z } from 'zod'
import { QuietReviewError } from '../errors.js'
import { cacheKey, readCacheEntry, writeCacheEntry } from '../infra/cache.js'
import { postJson, type FetchLike } from '../jev/post.js'
import {
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
  useCache: boolean
  cacheDir: string
  apiKey: () => string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => Date
}

// Asks the label model about each sampled item in order, from the cache when it can.
export async function runLabelModel(options: LabelModelOptions): Promise<AiAnswer[]> {
  const answers: AiAnswer[] = []
  for (const { item } of options.sample) {
    const body = buildLabelRequest(item, options.model)
    const key = cacheKey({ provider: PROVIDER, endpoint: CHAT_ENDPOINT, body })
    const cached = options.useCache ? await readCached(options.cacheDir, key) : null
    if (cached) {
      answers.push(toAnswer(item.id, cached.response, cached.costUsd))
      continue
    }
    const started = performance.now()
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
    const response = validateChatResponse(payload)
    const costUsd = response.usage.cost ?? 0
    await writeCacheEntry(options.cacheDir, key, {
      response,
      cachedAt: options.now().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      costUsd,
      costSource: 'reported',
    })
    answers.push(toAnswer(item.id, response, costUsd))
  }
  return answers
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
