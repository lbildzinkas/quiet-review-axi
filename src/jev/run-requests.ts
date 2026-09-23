import type { JevRequest } from '../core/state.js'
import type { FetchLike, JevProvider, JevResult } from './provider.js'
import type { Answer } from './schema.js'

export interface CallOutcome {
  request: JevRequest
  result: JevResult
  cached: boolean
}

export interface RunOutcome {
  calls: CallOutcome[]
  answers: Record<string, Answer>
}

export interface RunRequestsOptions {
  provider: JevProvider
  requests: JevRequest[]
  apiKey: () => string
  fetch: FetchLike
  sleep: (ms: number) => Promise<void>
  random: () => number
}

// Runs the Jev requests of one CLI run, one after another.
export async function runRequests(options: RunRequestsOptions): Promise<RunOutcome> {
  const calls: CallOutcome[] = []
  const answers: Record<string, Answer> = {}
  for (const request of options.requests) {
    const result = await options.provider.decide(request, {
      apiKey: options.apiKey(),
      fetch: options.fetch,
      sleep: options.sleep,
      random: options.random,
    })
    calls.push({ request, result, cached: false })
    Object.assign(answers, result.answers)
  }
  return { calls, answers }
}
