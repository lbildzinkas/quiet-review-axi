export type Probabilities = Record<string, number>

export interface ScriptedItem {
  act: number
  cat?: string | Probabilities
  sev?: number
  dup?: string | Probabilities
}

export interface FakeJevOptions {
  items?: Record<string, ScriptedItem>
  // Scripts an item by its comment text in the request state, for requests that reuse keys.
  byComment?: (comment: string) => ScriptedItem | undefined
  // A fixed snapshot, or one per call (1-based call number).
  snapshot?: string | ((call: number) => string)
  // Returns the reported `usage.cost`; `null` omits it from the response.
  cost?: (inputTokens: number) => number | null
  inputTokens?: number
}

export interface RecordedJevCall {
  url: string
  headers: Record<string, string>
  body: string
  json: Record<string, unknown>
}

const SEVERITY_LEVELS = 5

// A scripted stand-in for the Jev endpoint: it answers exactly the questions it is asked,
// from per-item scripts keyed by the item key used in the question ids (`c1_act` -> `c1`).
export function createFakeJev(options: FakeJevOptions = {}) {
  const calls: RecordedJevCall[] = []
  const snapshotFor = (call: number) =>
    typeof options.snapshot === 'function'
      ? options.snapshot(call)
      : (options.snapshot ?? 'typesafe/jev-1.13-20260917')

  function answer(
    questionId: string,
    question: { type: string; criteria?: unknown },
    comments: Record<string, { comment?: string }>,
  ) {
    const [key, kind] = splitQuestionId(questionId)
    const script = options.byComment?.(comments[key]?.comment ?? '') ??
      options.items?.[key] ?? { act: 0.5 }
    if (kind === 'act') return { type: 'noul', noul: script.act }
    if (kind === 'sev') return scoreAnswer(script.sev ?? 1)
    const optionsList = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
    if (kind === 'cat') return choiceAnswer(script.cat ?? 'other', optionsList)
    return choiceAnswer(script.dup ?? 'none', optionsList)
  }

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const body = String(init.body)
    const json = JSON.parse(body) as {
      state: { comments?: Record<string, { comment?: string }> }
      questions: Record<string, { type: string; criteria?: unknown }>
    }
    calls.push({ url, headers: headersToRecord(init.headers), body, json })
    const comments = json.state.comments ?? {}
    const answers = Object.fromEntries(
      Object.entries(json.questions).map(([id, question]) => [id, answer(id, question, comments)]),
    )
    const inputTokens = options.inputTokens ?? Math.ceil(body.length / 4)
    const cost = options.cost ? options.cost(inputTokens) : inputTokens * 0.042e-6
    const usage: Record<string, number> = { input_tokens: inputTokens, output_tokens: 10 }
    if (cost !== null) usage.cost = cost
    return jsonResponse(200, {
      id: `gen-dec-${calls.length}`,
      model: snapshotFor(calls.length),
      answers,
      usage,
    })
  }

  return { calls, handle }
}

function splitQuestionId(id: string): [string, string] {
  const index = id.lastIndexOf('_')
  return [id.slice(0, index), id.slice(index + 1)]
}

function choiceAnswer(script: string | Probabilities, options: string[]) {
  const probabilities: Probabilities = Object.fromEntries(options.map((option) => [option, 0]))
  if (typeof script === 'string') probabilities[script] = 1
  else Object.assign(probabilities, script)
  const [choice, top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ['none', 0]
  return { type: 'choice', choice, confidence: top, probabilities }
}

function scoreAnswer(score: number) {
  const lower = Math.floor(score)
  const probabilities: Probabilities = {}
  for (let level = 0; level < SEVERITY_LEVELS; level++) probabilities[String(level)] = 0
  probabilities[String(lower)] = 1 - (score - lower)
  if (lower + 1 < SEVERITY_LEVELS) probabilities[String(lower + 1)] = score - lower
  return { type: 'score', score, confidence: 0.9, probabilities, legend: {} }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}
