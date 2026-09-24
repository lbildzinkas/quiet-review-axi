import type { LabelledJudgment } from './evaluate.js'

// Any judge that returns a probability per item: a typed-decision model, or a language model
// read through its log-probabilities. A judge may return fewer judgments than items, for
// example when it stops at a budget; the missing items are reported, never guessed.
export interface Judgment {
  id: string
  probability: number
  // The model version that produced the probability, as the judge's backend reported it.
  snapshot: string
}

export interface Judge<Item, Result extends Judgment = Judgment> {
  judge: (items: readonly Item[]) => Promise<Result[]>
}

export interface LabelledItem<Item> {
  item: Item
  positive: boolean
  groups?: Record<string, string>
}

// Judges the items without their labels, then joins each judgment with its label.
export async function judgeLabelled<Item>(
  judge: Judge<Item>,
  labelled: readonly LabelledItem<Item>[],
  idOf: (item: Item) => string,
): Promise<{ judgments: LabelledJudgment[]; missing: string[] }> {
  const results = await judge.judge(labelled.map((entry) => entry.item))
  const byId = new Map(results.map((result) => [result.id, result]))
  const judgments: LabelledJudgment[] = []
  const missing: string[] = []
  for (const entry of labelled) {
    const id = idOf(entry.item)
    const result = byId.get(id)
    if (!result) {
      missing.push(id)
      continue
    }
    judgments.push({
      id,
      probability: result.probability,
      snapshot: result.snapshot,
      positive: entry.positive,
      ...(entry.groups === undefined ? {} : { groups: entry.groups }),
    })
  }
  return { judgments, missing }
}
