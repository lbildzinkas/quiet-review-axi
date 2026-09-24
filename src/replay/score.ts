import { cleanBody, hunkTail, type Item } from '../core/items.js'
import { createJevJudge, type JevJudgeOptions, type JudgeItem } from '../jev/judge.js'
import type { DrawnItem } from './build.js'
import type { FinalLabel } from './final-labels.js'

// One scored replay item, as stored in scores.jsonl. No comment text (spec 10.9).
export interface ScoreRow {
  id: string
  snapshot: string
  worth: number
  category: string
  severity: number
  dup_of: string | null
}

export interface ScoreOutcome {
  rows: ScoreRow[]
  // The labelled items, scored or not.
  total: number
  calls: number
  cachedCalls: number
  costUsd: number
  snapshots: string[]
  isStopped: boolean
}

// Scores the labelled (real or noise) items with Jev, batched per pull request on the shared
// request builder (spec 4.6, 5.2), so the replay measures the requests `score` sends.
export async function scoreLabelledItems(input: {
  items: DrawnItem[]
  labels: FinalLabel[]
  judgeOptions: JevJudgeOptions
}): Promise<ScoreOutcome> {
  const labelled = new Set(
    input.labels.filter((entry) => entry.label !== 'excluded').map((entry) => entry.id),
  )
  const judgeItems = toJudgeItems(input.items.filter((item) => labelled.has(item.id)))
  const jev = createJevJudge(input.judgeOptions)
  const judgments = await jev.judge.judge(judgeItems)
  const facts = jev.facts()
  const byId = new Map(judgments.map((judgment) => [judgment.id, judgment]))
  const rows = input.items.flatMap((item): ScoreRow[] => {
    const judgment = byId.get(item.id)
    if (!judgment) return []
    return [
      {
        id: item.id,
        snapshot: judgment.snapshot,
        worth: judgment.probability,
        category: judgment.category,
        severity: judgment.severity,
        dup_of: judgment.dupOf,
      },
    ]
  })
  return {
    rows,
    total: judgeItems.length,
    calls: facts.calls,
    cachedCalls: facts.cachedCalls,
    costUsd: facts.costUsd,
    snapshots: facts.snapshots,
    isStopped: facts.unjudged.length > 0,
  }
}

// One batch per pull request, in (repository, number) order. Within a pull request, items
// are keyed c1, c2, ... in creation order, then comment id (spec 4.4, R17).
export function toJudgeItems(items: DrawnItem[]): JudgeItem[] {
  const pulls = new Map<string, DrawnItem[]>()
  for (const item of items) {
    const batch = `${item.repository}#${item.pr}`
    pulls.set(batch, [...(pulls.get(batch) ?? []), item])
  }
  return [...pulls.entries()]
    .sort(
      ([, [a]], [, [b]]) =>
        compareText(a?.repository ?? '', b?.repository ?? '') || (a?.pr ?? 0) - (b?.pr ?? 0),
    )
    .flatMap(([batch, members]) =>
      [...members]
        .sort(
          (a, b) =>
            compareText(a.comment.created_at, b.comment.created_at) || a.comment.id - b.comment.id,
        )
        .map((drawn, index) => ({
          id: drawn.id,
          batch,
          header: { repository: drawn.repository, title: drawn.title },
          item: toItem(drawn, `c${index + 1}`),
        })),
    )
}

function toItem(drawn: DrawnItem, key: string): Item {
  const { comment } = drawn
  return {
    key,
    id: drawn.id,
    body: cleanBody(comment.body),
    code: hunkTail(comment.diff_hunk),
    context: 'hunk',
    path: comment.path,
    line: Number(comment.lines.split('-').at(-1)),
    lines: comment.lines,
    author: drawn.bot,
    url: comment.url,
  }
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
