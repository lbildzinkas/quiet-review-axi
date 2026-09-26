import type { Judge, Judgment } from '../calibration/index.js'
import { BUILT_IN_CUTOFFS, resolveCutoffs } from '../core/cutoffs.js'
import type { Item } from '../core/items.js'
import type { QuestionPack } from '../core/questions.js'
import { buildRequests, type JevRequest, type RequestHeader } from '../core/state.js'
import { decideItems } from '../core/verdict.js'
import type { Answer } from './schema.js'
import { runRequests, type RunRequestsOptions } from './run-requests.js'

// One item to judge. Items of the same batch (one pull request) share requests, built by the
// shared request builder exactly as `score` builds them; `item.key` is unique in its batch.
export interface JudgeItem {
  id: string
  batch: string
  header: RequestHeader
  item: Item
}

// Jev's answers for one item: the worth-acting-on probability plus the labelling answers.
export interface JevJudgment extends Judgment {
  category: string
  severity: number
  // Id of the earlier item of the same batch this one duplicates, or null (spec 6.4).
  dupOf: string | null
}

export interface JudgeRunFacts {
  calls: number
  cachedCalls: number
  costUsd: number
  snapshots: string[]
  // Input tokens of every call, cache hits included, as each response reported them.
  inputTokens: number
  // What the calls cost when they were paid for; cache hits count their first cost.
  answersCostUsd: number
  // Items left unjudged because the run stopped at --max-cost (spec 9.4).
  unjudged: string[]
}

export type JevJudgeOptions = Omit<RunRequestsOptions, 'requests' | 'questionPack'> & {
  pack: QuestionPack
}

const LABEL_CUTOFFS = resolveCutoffs({
  flags: { collapseBelow: BUILT_IN_CUTOFFS.collapseBelow, keepAt: BUILT_IN_CUTOFFS.keepAt },
})

// Jev as a calibration judge: batches items per pull request, runs the requests through the
// cache, budget and cost log, and reports each item's worth-acting-on probability with the
// snapshot that answered it. Items of a batch cut short by the budget are left out.
export function createJevJudge(options: JevJudgeOptions) {
  let facts: JudgeRunFacts = {
    calls: 0,
    cachedCalls: 0,
    costUsd: 0,
    snapshots: [],
    inputTokens: 0,
    answersCostUsd: 0,
    unjudged: [],
  }
  const judge: Judge<JudgeItem, JevJudgment> = {
    judge: async (items) => {
      const batches = groupBatches(items)
      const requestBatch = new Map<JevRequest, JudgeItem[]>()
      for (const batch of batches) {
        const [first] = batch
        if (!first) continue
        const requests = buildRequests({
          header: first.header,
          items: batch.map((entry) => entry.item),
          pack: options.pack,
        })
        for (const request of requests) requestBatch.set(request, batch)
      }
      const run = await runRequests({
        ...options,
        questionPack: options.pack.version,
        requests: [...requestBatch.keys()],
      })
      const judgments: JevJudgment[] = []
      for (const batch of batches) {
        const calls = run.calls.filter((call) => requestBatch.get(call.request) === batch)
        const answers: Record<string, Answer> = {}
        const snapshotOf = new Map<string, string>()
        for (const call of calls) {
          Object.assign(answers, call.result.answers)
          for (const key of call.request.itemKeys) snapshotOf.set(key, call.result.snapshot)
        }
        const scored = batch.filter((entry) => snapshotOf.has(entry.item.key))
        const idOf = new Map(batch.map((entry) => [entry.item.id, entry.id]))
        const decisions = decideItems({
          items: scored.map((entry) => entry.item),
          calls: calls.map((call) => call.request.itemKeys),
          answers,
          cutoffs: LABEL_CUTOFFS,
        })
        decisions.forEach((decision, index) => {
          const entry = scored[index]
          if (!entry) return
          judgments.push({
            id: entry.id,
            probability: decision.worth,
            snapshot: snapshotOf.get(entry.item.key) ?? '',
            category: decision.category,
            severity: decision.severity,
            dupOf: decision.dupOf === null ? null : (idOf.get(decision.dupOf) ?? null),
          })
        })
      }
      const judged = new Set(judgments.map((judgment) => judgment.id))
      facts = {
        calls: run.calls.length,
        cachedCalls: run.calls.filter((call) => call.cached).length,
        costUsd: run.calls.reduce(
          (total, call) => total + (call.cached ? 0 : call.result.costUsd),
          0,
        ),
        snapshots: [...new Set(run.calls.map((call) => call.result.snapshot))].sort(),
        inputTokens: run.calls.reduce((total, call) => total + call.result.inputTokens, 0),
        answersCostUsd: run.calls.reduce((total, call) => total + call.result.costUsd, 0),
        unjudged: items.filter((entry) => !judged.has(entry.id)).map((entry) => entry.id),
      }
      return judgments
    },
  }
  return { judge, facts: () => facts }
}

// Batches in first-seen order, each keeping its items' order.
function groupBatches(items: readonly JudgeItem[]): JudgeItem[][] {
  const batches = new Map<string, JudgeItem[]>()
  for (const entry of items) batches.set(entry.batch, [...(batches.get(entry.batch) ?? []), entry])
  return [...batches.values()]
}
