import { headersToRecord, jsonResponse } from './fake-jev.js'

export const LABEL_MODEL = 'example/label-model'

export type ScriptedAnswer = string | { status: number; body?: unknown }

export interface FakeLabelModelOptions {
  // The answer text for a comment, found by the `(#<id>)` marker the replay world puts in every
  // comment body. Default: like the main automatic rule, `real` when the evidence shows a
  // change at the commented lines and `noise` otherwise, so ordinary fixtures agree.
  answer?: (commentId: number) => ScriptedAnswer
  // Reported `usage.cost`; `null` omits it from the response.
  cost?: number | null
  promptTokens?: number
  completionTokens?: number
  // The models the pricing list offers, with USD prices per token; a field may be left out.
  models?: Record<string, { prompt?: string; completion?: string; request?: string }>
  snapshot?: string
}

export interface RecordedChatCall {
  headers: Record<string, string>
  body: string
  json: { model: string; messages: { role: string; content: string }[] } & Record<string, unknown>
}

// A scripted stand-in for OpenRouter's model list and chat completions endpoints: the label
// model answers each comment from a per-comment script.
export function createFakeLabelModel(options: FakeLabelModelOptions = {}) {
  const chatCalls: RecordedChatCall[] = []
  const pricingCalls: string[] = []
  const models = options.models ?? { [LABEL_MODEL]: { prompt: '0.000003', completion: '0.000015' } }

  // Only the model list and chat completions; Jev's decision endpoint is another fake's.
  function matches(url: string) {
    const path = new URL(url).pathname
    return (
      url.startsWith('https://openrouter.ai/') &&
      (path === '/api/v1/models' || path === '/api/v1/chat/completions')
    )
  }

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const path = new URL(url).pathname
    if (path === '/api/v1/models' && (init.method ?? 'GET') === 'GET') {
      pricingCalls.push(url)
      return jsonResponse(200, {
        data: Object.entries(models).map(([id, pricing]) => ({
          id,
          pricing,
        })),
      })
    }
    if (path !== '/api/v1/chat/completions') return jsonResponse(404, { error: { code: 404 } })
    const body = String(init.body)
    const json = JSON.parse(body) as RecordedChatCall['json']
    chatCalls.push({ headers: headersToRecord(init.headers), body, json })
    const text = json.messages.map((message) => message.content).join('\n')
    const commentId = Number(text.match(/\(#(\d+)\)/)?.[1] ?? 0)
    const scripted = options.answer?.(commentId) ?? labelFromEvidence(text)
    if (typeof scripted !== 'string')
      return jsonResponse(scripted.status, scripted.body ?? { error: { code: scripted.status } })
    const usage: Record<string, number> = {
      prompt_tokens: options.promptTokens ?? Math.ceil(body.length / 4),
      completion_tokens: options.completionTokens ?? 20,
    }
    usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    const cost = options.cost === undefined ? 0.002 : options.cost
    if (cost !== null) usage.cost = cost
    return jsonResponse(200, {
      id: `gen-chat-${chatCalls.length}`,
      object: 'chat.completion',
      model: options.snapshot ?? json.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: labelText(scripted) },
        },
      ],
      usage,
    })
  }

  return { chatCalls, pricingCalls, matches, handle }
}

// A bare label becomes the JSON answer the prompt asks for; anything else is sent verbatim.
function labelText(scripted: string): string {
  if (['real', 'noise', 'unsure'].includes(scripted))
    return JSON.stringify({ label: scripted, reason: `The evidence says ${scripted}.` })
  return scripted
}

// The evidence's `changes_after_comment` is diff hunks when the file changed near the comment.
function labelFromEvidence(text: string): string {
  return /"changes_after_comment": "@@/.test(text) ? 'real' : 'noise'
}
