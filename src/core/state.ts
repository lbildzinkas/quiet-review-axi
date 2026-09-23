import type { Item } from './items.js'
import { itemQuestions, type Question } from './questions.js'

export interface RequestHeader {
  repository?: string
  title?: string
}

export interface JevRequest {
  itemKeys: string[]
  state: Record<string, unknown>
  questions: Record<string, Question>
}

// Builds the Jev request(s) for one pull request or findings file (spec 5.2, 5.3).
export function buildRequests(input: { header: RequestHeader; items: Item[] }): JevRequest[] {
  return [buildRequest(input.header, input.items)]
}

function buildRequest(header: RequestHeader, items: Item[]): JevRequest {
  const comments: Record<string, unknown> = {}
  let questions: Record<string, Question> = {}
  for (const item of items) {
    comments[item.key] = stateEntry(item)
    questions = { ...questions, ...itemQuestions(item.key, []) }
  }
  const state: Record<string, unknown> = {}
  if (header.repository !== undefined || header.title !== undefined) state.pr = header
  state.comments = comments
  return { itemKeys: items.map((item) => item.key), state, questions }
}

function stateEntry(item: Item) {
  const entry: Record<string, string> = {}
  if (item.path !== null) entry.path = item.path
  if (item.lines !== null) entry.lines = item.lines
  entry.code = item.code
  entry.comment = item.body
  return entry
}
