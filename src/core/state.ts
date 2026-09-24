import type { Item } from './items.js'
import { BUILT_IN_PACK, itemQuestions, type Question, type QuestionPack } from './questions.js'

export interface RequestHeader {
  repository?: string
  title?: string
}

export interface JevRequest {
  itemKeys: string[]
  state: Record<string, unknown>
  questions: Record<string, Question>
}

// Headroom under Jev's 32k context budget (spec 5.2, Jev guide 2.5).
export const REQUEST_TOKEN_BUDGET = 26_000

// A fixed function of the request text, never corrected from observed usage, so the same
// data always splits the same way (spec 5.2, R17).
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function estimateRequestTokens(request: JevRequest): number {
  return estimateTokens(JSON.stringify({ state: request.state, questions: request.questions }))
}

// Builds the Jev request(s) for one pull request or findings file (spec 5.2, 5.3): one
// request when everything fits, otherwise the fewest file-grouped requests. The questions come
// from the built-in pack unless another pack is given.
export function buildRequests(input: {
  header: RequestHeader
  items: Item[]
  pack?: QuestionPack
}): JevRequest[] {
  const { header, items } = input
  const pack = input.pack ?? BUILT_IN_PACK
  if (items.length === 0) return []
  const whole = buildRequest(header, items, pack)
  if (estimateRequestTokens(whole) <= REQUEST_TOKEN_BUDGET) return [whole]
  const fits = (candidate: Item[]) =>
    estimateRequestTokens(buildRequest(header, inItemOrder(items, candidate), pack)) <=
    REQUEST_TOKEN_BUDGET
  const calls: Item[][] = []
  for (const group of fileGroups(items).flatMap((fileGroup) =>
    splitOversizedGroup(fileGroup, fits),
  )) {
    const call = calls.find((existing) => fits([...existing, ...group]))
    if (call) call.push(...group)
    else calls.push([...group])
  }
  return calls.map((call) => buildRequest(header, inItemOrder(items, call), pack))
}

function fileGroups(items: Item[]): Item[][] {
  const groups = new Map<string, Item[]>()
  for (const item of items) {
    const path = item.path ?? ''
    groups.set(path, [...(groups.get(path) ?? []), item])
  }
  return [...groups.entries()].sort(([a], [b]) => compareText(a, b)).map(([, group]) => group)
}

// A single file's group is split, in line order, only when it alone is over budget.
function splitOversizedGroup(group: Item[], fits: (items: Item[]) => boolean): Item[][] {
  if (fits(group)) return [group]
  const byLine = [...group].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  const chunks: Item[][] = []
  for (const item of byLine) {
    const last = chunks.at(-1)
    if (last && fits([...last, item])) last.push(item)
    else chunks.push([item])
  }
  return chunks
}

function inItemOrder(items: Item[], subset: Item[]): Item[] {
  const members = new Set(subset)
  return items.filter((item) => members.has(item))
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function buildRequest(header: RequestHeader, items: Item[], pack: QuestionPack): JevRequest {
  const comments: Record<string, unknown> = {}
  let questions: Record<string, Question> = {}
  items.forEach((item, index) => {
    comments[item.key] = stateEntry(item)
    questions = {
      ...questions,
      ...itemQuestions(item.key, duplicateCandidates(items, index), pack),
    }
  })
  const state: Record<string, unknown> = {}
  if (header.repository !== undefined || header.title !== undefined) state.pr = prHeader(header)
  state.comments = comments
  return { itemKeys: items.map((item) => item.key), state, questions }
}

function prHeader(header: RequestHeader) {
  const pr: Record<string, string> = {}
  if (header.repository !== undefined) pr.repository = header.repository
  if (header.title !== undefined) pr.title = header.title
  return pr
}

function stateEntry(item: Item) {
  const entry: Record<string, string> = {}
  if (item.path !== null) entry.path = item.path
  if (item.lines !== null) entry.lines = item.lines
  entry.code = item.code
  entry.comment = item.body
  return entry
}

// Jev accepts at most 255 Choice options; one is `none` (Jev guide 2.2).
const MAX_DUPLICATE_OPTIONS = 254
const NEAREST_OTHER_CANDIDATES = 10

// Duplicate options (spec 5.4.4): every earlier item on the same file, plus the nearest
// earlier items elsewhere, in item order.
function duplicateCandidates(items: Item[], index: number): string[] {
  const current = items[index]
  const earlier = items.slice(0, index)
  const samePath = earlier.filter((candidate) => candidate.path === current?.path)
  const others = earlier
    .filter((candidate) => candidate.path !== current?.path)
    .slice(-NEAREST_OTHER_CANDIDATES)
  const chosen = new Set([...samePath, ...others])
  return earlier
    .filter((candidate) => chosen.has(candidate))
    .slice(-MAX_DUPLICATE_OPTIONS)
    .map((candidate) => candidate.key)
}
