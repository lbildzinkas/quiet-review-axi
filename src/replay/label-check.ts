import { cleanBody } from '../core/items.js'
import type { DrawnItem } from './build.js'
import type { Label } from './label.js'
import prompt from './label-prompt.json' with { type: 'json' }

// The label check (spec 10.6): an independent AI label on a sample of the automatic labels.

export const LABEL_PROMPT_VERSION: string = prompt.version

export type AiLabel = 'real' | 'noise' | 'unsure'

export interface LabelledItem {
  item: DrawnItem
  label: Label
}

export function drawCheckSample(labelled: LabelledItem[]): LabelledItem[] {
  return labelled.filter((entry) => entry.label !== 'excluded')
}

// The chat request for one item, built from the fixed template: the same item and model
// always give the same body (R17). The automatic label is never sent.
export function buildLabelRequest(item: DrawnItem, model: string): Record<string, unknown> {
  const evidence = {
    comment: cleanBody(item.comment.body),
    code_at_comment_time: item.comment.diff_hunk,
  }
  return {
    model,
    messages: [
      { role: 'system', content: prompt.system.join('\n') },
      { role: 'user', content: `${prompt.user}\n${JSON.stringify(evidence, null, 2)}` },
    ],
    temperature: prompt.temperature,
    max_tokens: prompt.max_tokens,
  }
}

export interface ParsedAnswer {
  label: AiLabel
  reason: string
}

export function parseLabelAnswer(content: string): ParsedAnswer {
  const parsed = JSON.parse(content) as { label: AiLabel; reason: string }
  return { label: parsed.label, reason: parsed.reason }
}

export interface Agreement {
  // Items where the AI gave real or noise.
  compared: number
  agreement: number | null
  kappa: number | null
}

// Raw agreement and Cohen's kappa between the automatic and the AI labels, over items where
// the AI did not answer `unsure`.
export function agreementOf(pairs: { automatic: Label; ai: AiLabel }[]): Agreement {
  const compared = pairs.filter((pair) => pair.ai !== 'unsure')
  const n = compared.length
  if (n === 0) return { compared: 0, agreement: null, kappa: null }
  const agreed = compared.filter((pair) => pair.ai === pair.automatic).length
  const observed = agreed / n
  const share = (side: 'automatic' | 'ai', label: string) =>
    compared.filter((pair) => pair[side] === label).length / n
  const expected =
    share('automatic', 'real') * share('ai', 'real') +
    share('automatic', 'noise') * share('ai', 'noise')
  return {
    compared: n,
    agreement: observed,
    kappa: expected === 1 ? null : (observed - expected) / (1 - expected),
  }
}
