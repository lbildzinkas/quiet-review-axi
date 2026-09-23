import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JevQuestions } from '../src/jev/provider.js'
import { PROVIDERS } from '../src/jev/providers.js'
import { jsonResponse } from './helpers/fake-jev.js'

const REQUEST: JevQuestions = {
  state: { comments: { c1: { code: '+x', comment: 'Bug.' } } },
  questions: { c1_act: { type: 'noul', instructions: 'Is `comments.c1.comment` right?' } },
}

const OK_BODY = {
  id: 'gen-dec-1',
  model: 'typesafe/jev-1.13-20260917',
  answers: { c1_act: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 1000, output_tokens: 5, cost: 0.00005 },
}

interface Attempt {
  url: string
  init: RequestInit
}

function scripted(...responses: (() => Promise<Response> | Response)[]) {
  const attempts: Attempt[] = []
  const sleeps: number[] = []
  const fetch = async (url: string, init: RequestInit) => {
    attempts.push({ url, init })
    const next = responses[Math.min(attempts.length - 1, responses.length - 1)]
    if (!next) throw new Error('no scripted response')
    return next()
  }
  const options = {
    apiKey: 'sk-test',
    fetch,
    sleep: async (ms: number) => void sleeps.push(ms),
    random: () => 0.5,
  }
  return { attempts, sleeps, options }
}

const ok = () => jsonResponse(200, OK_BODY)
const status =
  (code: number, body: unknown = { error: { code, message: 'nope' } }, headers = {}) =>
  () =>
    jsonResponse(code, body, headers)

describe('provider requests', () => {
  it('sends the OpenRouter body with zero-data-retention provider preferences', async () => {
    const { attempts, options } = scripted(ok)

    await PROVIDERS.openrouter.decide(REQUEST, options)

    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.url).toBe('https://openrouter.ai/api/v1/systemone')
    expect(attempts[0]?.init.method).toBe('POST')
    expect(new Headers(attempts[0]?.init.headers).get('authorization')).toBe('Bearer sk-test')
    expect(new Headers(attempts[0]?.init.headers).get('content-type')).toBe('application/json')
    expect(attempts[0]?.init.body).toBe(
      '{"model":"typesafe/jev-1.13","state":{"comments":{"c1":{"code":"+x","comment":"Bug."}}},"questions":{"c1_act":{"type":"noul","instructions":"Is `comments.c1.comment` right?"}},"provider":{"zdr":true,"data_collection":"deny","allow_fallbacks":false}}',
    )
  })

  it('sends the TypeSafe body with its own model id and no provider preferences', async () => {
    const { attempts, options } = scripted(ok)

    await PROVIDERS.typesafe.decide(REQUEST, options)

    expect(attempts[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(attempts[0]?.init.body).toBe(
      '{"model":"jev-1.13.0","state":{"comments":{"c1":{"code":"+x","comment":"Bug."}}},"questions":{"c1_act":{"type":"noul","instructions":"Is `comments.c1.comment` right?"}}}',
    )
  })
})

describe('provider results', () => {
  it('returns the answers, snapshot, response id and the cost OpenRouter reports', async () => {
    const { options } = scripted(ok)

    const result = await PROVIDERS.openrouter.decide(REQUEST, options)

    expect(result).toMatchObject({
      answers: { c1_act: { type: 'noul', noul: 0.8 } },
      snapshot: 'typesafe/jev-1.13-20260917',
      responseId: 'gen-dec-1',
      inputTokens: 1000,
      costUsd: 0.00005,
      costSource: 'reported',
      retries: 0,
    })
  })

  it('computes the cost from the list price when OpenRouter omits it', async () => {
    const { options } = scripted(() =>
      jsonResponse(200, { ...OK_BODY, usage: { input_tokens: 1000 } }),
    )

    const result = await PROVIDERS.openrouter.decide(REQUEST, options)

    expect(result.costSource).toBe('computed')
    expect(result.costUsd).toBeCloseTo(0.000042, 12)
  })

  it('always computes the TypeSafe cost from input tokens at $0.042 per million', async () => {
    const { options } = scripted(() =>
      jsonResponse(200, { ...OK_BODY, usage: { input_tokens: 476 } }),
    )

    const result = await PROVIDERS.typesafe.decide(REQUEST, options)

    expect(result.costSource).toBe('computed')
    expect(result.costUsd).toBeCloseTo(0.000019992, 12)
  })

  it('rejects a response missing an asked question as INVALID_RESPONSE', async () => {
    const { options } = scripted(() => jsonResponse(200, { ...OK_BODY, answers: {} }))

    await expect(PROVIDERS.openrouter.decide(REQUEST, options)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('rejects a Noul outside 0-1 and a wrong answer type as INVALID_RESPONSE', async () => {
    const outOfRange = scripted(() =>
      jsonResponse(200, { ...OK_BODY, answers: { c1_act: { type: 'noul', noul: 1.5 } } }),
    )
    const wrongType = scripted(() =>
      jsonResponse(200, { ...OK_BODY, answers: { c1_act: { type: 'score', score: 2 } } }),
    )

    await expect(PROVIDERS.openrouter.decide(REQUEST, outOfRange.options)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
    await expect(PROVIDERS.openrouter.decide(REQUEST, wrongType.options)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })
})

describe('provider errors and retries', () => {
  afterEach(() => void vi.useRealTimers())

  it('maps 401 and 403 to PROVIDER_AUTH with a hint naming the key variable', async () => {
    const openrouter = scripted(status(401))
    const typesafe = scripted(status(403, { detail: { error_type: 'authentication_error' } }))

    await expect(PROVIDERS.openrouter.decide(REQUEST, openrouter.options)).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
      suggestions: [expect.stringContaining('OPENROUTER_API_KEY')],
    })
    await expect(PROVIDERS.typesafe.decide(REQUEST, typesafe.options)).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
      suggestions: [expect.stringContaining('TYPESAFE_API_KEY')],
    })
    expect(openrouter.attempts).toHaveLength(1)
  })

  it('retries a 402 from the in-flight budget as transient', async () => {
    const inFlight = status(402, {
      error: {
        code: 402,
        message: 'hold',
        metadata: { limit_source: 'openrouter_in_flight_budget' },
      },
    })
    const { attempts, options } = scripted(inFlight, ok)

    const result = await PROVIDERS.openrouter.decide(REQUEST, options)

    expect(attempts).toHaveLength(2)
    expect(result.retries).toBe(1)
  })

  it('maps any other 402 to PROVIDER_CREDITS without retrying', async () => {
    const { attempts, options } = scripted(
      status(402, {
        error: {
          code: 402,
          message: 'no credits',
          metadata: { limit_source: 'openrouter_credits' },
        },
      }),
    )

    await expect(PROVIDERS.openrouter.decide(REQUEST, options)).rejects.toMatchObject({
      code: 'PROVIDER_CREDITS',
    })
    expect(attempts).toHaveLength(1)
  })

  it('maps 400, 413 and 422 to PROVIDER_ERROR without retrying, keeping the body for the call log', async () => {
    for (const code of [400, 413, 422]) {
      const { attempts, options } = scripted(
        status(code, { detail: 'questions.c1_act: bad field' }),
      )

      await expect(PROVIDERS.typesafe.decide(REQUEST, options)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        providerStatus: code,
        providerBody: '{"detail":"questions.c1_act: bad field"}',
      })
      expect(attempts).toHaveLength(1)
    }
  })

  it('honours Retry-After on 429 and succeeds on a later attempt', async () => {
    const { sleeps, options } = scripted(status(429, {}, { 'retry-after': '2' }), ok)

    await PROVIDERS.openrouter.decide(REQUEST, options)

    expect(sleeps).toEqual([2000])
  })

  it('honours retry-after-ms over Retry-After', async () => {
    const { sleeps, options } = scripted(
      status(429, {}, { 'retry-after': '2', 'retry-after-ms': '750' }),
      ok,
    )

    await PROVIDERS.typesafe.decide(REQUEST, options)

    expect(sleeps).toEqual([750])
  })

  it('maps a 429 that persists after two retries to PROVIDER_RATE_LIMIT', async () => {
    const { attempts, options } = scripted(status(429))

    await expect(PROVIDERS.openrouter.decide(REQUEST, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
    })
    expect(attempts).toHaveLength(3)
  })

  it('backs off 500 ms doubling, with up to 25% jitter, when no retry hint is given', async () => {
    const { sleeps, options } = scripted(status(529))

    await expect(PROVIDERS.typesafe.decide(REQUEST, options)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    })
    // random() = 0.5 takes 12.5% off each wait.
    expect(sleeps).toEqual([437.5, 875])
  })

  it('ignores a retry hint above 60 seconds and uses the backoff instead', async () => {
    const { sleeps, options } = scripted(status(503, {}, { 'retry-after': '120' }), ok)

    await PROVIDERS.openrouter.decide(REQUEST, options)

    expect(sleeps).toEqual([437.5])
  })

  it('retries 408 and 5xx, then maps the failure to PROVIDER_ERROR', async () => {
    for (const code of [408, 500, 502]) {
      const { attempts, options } = scripted(status(code))

      await expect(PROVIDERS.openrouter.decide(REQUEST, options)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      })
      expect(attempts).toHaveLength(3)
    }
  })

  it('retries network failures, then maps them to PROVIDER_ERROR', async () => {
    const { attempts, options } = scripted(() => Promise.reject(new TypeError('fetch failed')))

    await expect(PROVIDERS.openrouter.decide(REQUEST, options)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    })
    expect(attempts).toHaveLength(3)
  })

  it('aborts an attempt after 10 seconds and treats it as a retryable timeout', async () => {
    vi.useFakeTimers()
    const hanging = scripted(() => new Promise<Response>(() => {}))
    const aborted: boolean[] = []
    const fetch = (url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        void hanging.options.fetch(url, init)
        init.signal?.addEventListener('abort', () => {
          aborted.push(true)
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })

    const outcome = expect(
      PROVIDERS.openrouter.decide(REQUEST, { ...hanging.options, fetch }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('timed out'),
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(aborted).toEqual([])
    await vi.advanceTimersByTimeAsync(30_001)
    await outcome
    expect(aborted).toHaveLength(3)
  })
})
