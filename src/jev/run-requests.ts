import { estimateRequestTokens, type JevRequest } from '../core/state.js'
import { QuietReviewError } from '../errors.js'
import { createBudget } from '../infra/budget.js'
import { cacheKey, readCacheEntry, writeCacheEntry } from '../infra/cache.js'
import { appendCallLog, type CallLogLine } from '../infra/call-log.js'
import { validateResponse, type FetchLike, type JevProvider, type JevResult } from './provider.js'
import type { Answer } from './schema.js'

export interface CallOutcome {
  request: JevRequest
  result: JevResult
  cached: boolean
  cacheKey: string
}

export interface RunOutcome {
  calls: CallOutcome[]
  answers: Record<string, Answer>
  // Requests not made because the next paid call would have passed --max-cost.
  skipped: JevRequest[]
}

export interface RunRequestsOptions {
  command: string
  runId: string
  // Version of the question pack the requests were built from (spec 5.4.5).
  questionPack: string
  provider: JevProvider
  requests: JevRequest[]
  maxCostUsd: number
  useCache: boolean
  cacheDir: string
  callLogPath: string
  // The private-data notice to record with each call, when the run has one (spec 8.3).
  notice?: string
  apiKey: () => string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
  now: () => Date
  redact: (text: string) => string
}

// Provider error bodies can echo request text, so only their start is logged.
const MAX_LOGGED_BODY_CHARACTERS = 500

// Runs the Jev requests of one CLI run in order: cache first, then paid calls within the
// budget (spec 9.2, 9.4). After a budget stop, remaining cache hits are still served. Every attempt, cache hits included, is logged (spec 9.3).
export async function runRequests(options: RunRequestsOptions): Promise<RunOutcome> {
  const { provider } = options
  const budget = createBudget(options.maxCostUsd)
  const calls: CallOutcome[] = []
  const answers: Record<string, Answer> = {}
  const skipped: JevRequest[] = []
  for (const request of options.requests) {
    const key = cacheKey({
      provider: provider.name,
      endpoint: provider.endpoint,
      body: provider.buildBody(request),
    })
    const baseLine = {
      run: options.runId,
      command: options.command,
      provider: provider.name,
      model: provider.model,
      question_pack: options.questionPack,
      request_hash: key,
      items: request.itemKeys.length,
      ...(options.notice === undefined ? {} : { notice: options.notice }),
    }
    const cached = options.useCache ? await readCached(options.cacheDir, key, request) : null
    if (cached) {
      calls.push({ request, result: cached, cached: true, cacheKey: key })
      Object.assign(answers, cached.answers)
      await log(options, {
        ...baseLine,
        ...resultFields(cached),
        cost_usd: 0,
        cached: true,
        latency_ms: 0,
      })
      continue
    }
    // Once one paid call is over budget, no later paid call is made; cache hits still are.
    if (skipped.length > 0 || !budget.canAfford(estimateRequestTokens(request))) {
      skipped.push(request)
      continue
    }
    const started = performance.now()
    let result: JevResult
    try {
      result = await provider.decide(request, {
        apiKey: options.apiKey(),
        fetch: options.fetch,
        sleep: options.sleep,
        random: options.random,
      })
    } catch (error) {
      if (error instanceof QuietReviewError && error.code !== 'MISSING_KEY')
        await log(options, { ...baseLine, ...failureFields(error, options.redact) })
      throw error
    }
    const latencyMs = Math.round(performance.now() - started)
    budget.spend(result.costUsd)
    await writeCacheEntry(options.cacheDir, key, {
      response: result.response,
      cachedAt: options.now().toISOString(),
      latencyMs,
      costUsd: result.costUsd,
      costSource: result.costSource,
    })
    calls.push({ request, result, cached: false, cacheKey: key })
    Object.assign(answers, result.answers)
    await log(options, {
      ...baseLine,
      ...resultFields(result),
      cached: false,
      latency_ms: latencyMs,
    })
  }
  return { calls, answers, skipped }
}

async function readCached(
  dir: string,
  key: string,
  request: JevRequest,
): Promise<JevResult | null> {
  const entry = await readCacheEntry(dir, key)
  if (!entry) return null
  try {
    const parsed = validateResponse(entry.response, request.questions)
    return { ...parsed, costUsd: entry.costUsd, costSource: entry.costSource, retries: 0 }
  } catch {
    // A cache entry that no longer validates is treated as a miss and replaced.
    return null
  }
}

function resultFields(result: JevResult) {
  return {
    snapshot: result.snapshot,
    response_id: result.responseId ?? null,
    input_tokens: result.inputTokens,
    cost_usd: result.costUsd,
    cost_source: result.costSource,
    retries: result.retries,
    status: 'ok' as const,
  }
}

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

async function log(options: RunRequestsOptions, line: Omit<CallLogLine, 'ts'>) {
  await appendCallLog(options.callLogPath, { ts: options.now().toISOString(), ...line })
}
