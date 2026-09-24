import { QuietReviewError } from '../errors.js'
import type { Budget } from '../infra/budget.js'
import { cacheKey, readCacheEntry, writeCacheEntry, type CostSource } from '../infra/cache.js'
import { appendCallLog, type CallLogLine } from '../infra/call-log.js'
import type { DrawnItem } from './build.js'
import {
  LABEL_PROMPT_VERSION,
  parseLabelAnswer,
  type AiLabel,
  type LabelledItem,
} from './label-check.js'

// How the label check reaches its model (spec 10.6). A backend turns one item into a fixed
// request, and a request into a reply; asking in order, caching, the budget and the call log
// are shared by every backend. OpenRouter's chat API and the Pi CLI are backends today; a
// backend for another subscription CLI plugs in the same way.
export interface LabelBackend<R = unknown> {
  // Names the backend in the cache key and in the call log's `provider`.
  provider: string
  // The configured model, as the call log and the stage record name it.
  model: string
  // How the progress line names the model.
  describe: string
  // The request for one item: the same item always gives the same request (R17). `body` is
  // what the cache key hashes, so it holds everything that shapes the answer and no secret.
  request: (item: DrawnItem) => LabelRequest
  // False when the call could pass --max-cost (spec 9.4); the item is then left unlabelled.
  // A backend that costs nothing per call always fits.
  fits: (request: LabelRequest, budget: Budget) => Promise<boolean>
  // Makes the call; failures are QuietReviewErrors. Only a validated response is returned.
  call: (request: LabelRequest) => Promise<{ response: R; costUsd: number; costSource: CostSource }>
  // A cached response that still validates, or null to ask again.
  validate: (cached: unknown) => R | null
  read: (response: R) => BackendReply
}

export interface LabelRequest {
  endpoint: string
  body: unknown
}

// What a backend's response says, in the call log's terms.
export interface BackendReply {
  content: string
  snapshot: string
  responseId: string | null
  inputTokens: number | null
  outputTokens: number | null
  // Extra run facts for the call log, such as a CLI's version; never text or secrets.
  logFields?: Partial<CallLogLine>
}

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
  backend: LabelBackend
  // Shared by every paid call of the invocation (spec 9.4).
  budget: Budget
  runId: string
  callLogPath: string
  redact: (text: string) => string
  progress: (line: string) => void
  useCache: boolean
  cacheDir: string
  now: () => Date
}

export interface LabelModelOutcome {
  answers: AiAnswer[]
  // Items left without an answer because the next paid call could have passed --max-cost.
  unlabelled: string[]
}

// Asks the label model about each sampled item in order, from the cache when it can, and
// calls it only while the call fits the budget. After a stop, cache hits are still served.
// Every attempt, cache hits included, is logged without any text (spec 9.3).
export async function runLabelModel(options: LabelModelOptions): Promise<LabelModelOutcome> {
  const { backend } = options
  const answers: AiAnswer[] = []
  const unlabelled: string[] = []
  options.progress(
    `check: asking ${backend.describe} about ${options.sample.length} sampled comments`,
  )
  for (const { item } of options.sample) {
    const request = backend.request(item)
    const key = cacheKey({
      provider: backend.provider,
      endpoint: request.endpoint,
      body: request.body,
    })
    const baseLine = {
      run: options.runId,
      command: 'replay',
      provider: backend.provider,
      model: backend.model,
      prompt: LABEL_PROMPT_VERSION,
      request_hash: key,
      items: 1,
    }
    const cached = options.useCache ? await readCached(options.cacheDir, key, backend) : null
    if (cached) {
      const reply = backend.read(cached.response)
      answers.push(toAnswer(item.id, reply, cached.costUsd))
      await log(options, {
        ...baseLine,
        ...replyFields(reply),
        cost_usd: 0,
        cost_source: cached.costSource,
        cached: true,
        latency_ms: 0,
        status: 'ok',
      })
      continue
    }
    if (unlabelled.length > 0 || !(await backend.fits(request, options.budget))) {
      unlabelled.push(item.id)
      continue
    }
    const started = performance.now()
    let outcome: Awaited<ReturnType<LabelBackend['call']>>
    try {
      outcome = await backend.call(request)
    } catch (error) {
      if (error instanceof QuietReviewError && error.code !== 'MISSING_KEY')
        await log(options, { ...baseLine, ...failureFields(error, options.redact) })
      throw error
    }
    const latencyMs = Math.round(performance.now() - started)
    const { response, costUsd, costSource } = outcome
    options.budget.spend(costUsd)
    await writeCacheEntry(options.cacheDir, key, {
      response,
      cachedAt: options.now().toISOString(),
      latencyMs,
      costUsd,
      costSource,
    })
    const reply = backend.read(response)
    answers.push(toAnswer(item.id, reply, costUsd))
    await log(options, {
      ...baseLine,
      ...replyFields(reply),
      cost_usd: costUsd,
      cost_source: costSource,
      cached: false,
      latency_ms: latencyMs,
      status: 'ok',
    })
  }
  return { answers, unlabelled }
}

function replyFields(reply: BackendReply) {
  return {
    snapshot: reply.snapshot,
    response_id: reply.responseId,
    input_tokens: reply.inputTokens,
    output_tokens: reply.outputTokens,
    ...reply.logFields,
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

async function readCached(dir: string, key: string, backend: LabelBackend) {
  const entry = await readCacheEntry<unknown>(dir, key)
  if (!entry) return null
  // An entry that no longer validates is treated as a miss and replaced.
  const response = backend.validate(entry.response)
  return response === null ? null : { ...entry, response }
}

function toAnswer(id: string, reply: BackendReply, costUsd: number): AiAnswer {
  return { id, ...parseLabelAnswer(reply.content), model: reply.snapshot, cost_usd: costUsd }
}
