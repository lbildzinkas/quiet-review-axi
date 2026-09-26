import { cleanBody } from '../core/items.js'
import { gitHubError, type GitHubClient } from '../inputs/github.js'
import type { DrawnItem } from './build.js'
import { baseSha, fetchCompareFiles, fetchFileText, type CompareFile } from './github.js'
import type { ContextBlock } from './variants.js'

// The context blocks of the context ablation, read from GitHub through the replay's cached,
// read-only client. Every block holds only what existed when the comment was written: replies,
// resolution, later commits and the merge outcome are what the labels come from, so any of them
// in the context would leak the answer.

// Each block's size limit, in estimated tokens (characters / 3.5, as the request builder
// estimates), so a request with every block stays well inside Jev's 32k context.
export const BLOCK_TOKEN_BUDGETS = {
  pr_description: 1500,
  linked_issue: 1500,
  // The wider code block: the file window, and the rest of the diff hunk.
  file_window: 1500,
  hunk_rest: 500,
} as const

// How far the file window reaches on each side of the commented lines, and how much of one
// line it shows (minified code can put a whole file on one line).
const WINDOW_LINES_EACH_SIDE = 60
const MAX_LINE_CHARACTERS = 400

const CHARACTERS_PER_TOKEN = 3.5

function characters(tokens: number): number {
  return Math.floor(tokens * CHARACTERS_PER_TOKEN)
}

// One pull request's context, as it read when its first drawn comment was written: every
// comment in its request shares it, so nothing later than any of them enters.
export interface PullContext {
  title: string | null
  description: string | null
  // Why the description is not shown, when it is not.
  description_reason?: string
  // The issue the pull request linked before the comment: named by a closing keyword in the
  // description, or linked in the sidebar.
  linked_issue: { title: string; body: string } | null
  linked_issue_reason?: string
}

// One comment's wider code, at the comment's commit.
export interface ItemContext {
  file: string | null
  file_reason?: string
  hunk_rest: string | null
  hunk_rest_reason?: string
}

export interface ReplayContext {
  // Keyed by `owner/repo#number`, the batch key of the score stage.
  pulls: Map<string, PullContext>
  // Keyed by item id.
  items: Map<string, ItemContext>
}

export interface BlockCoverage {
  block: ContextBlock
  shown: string
  // Why the block is missing where it is, with counts, for example "no linked issue 9".
  missing: string
}

// How often each chosen block could be shown, and why not where it could not.
export function blockCoverage(
  context: ReplayContext,
  blocks: readonly ContextBlock[],
): BlockCoverage[] {
  const pulls = [...context.pulls.values()]
  const items = [...context.items.values()]
  return blocks.map((block) => {
    if (block === 'wider_code') {
      const files = items.filter((item) => item.file !== null).length
      const hunks = items.filter((item) => item.hunk_rest !== null).length
      const missing = [
        ...tally(items.flatMap((item) => (item.file === null ? [item.file_reason] : []))),
        ...tally(
          items.flatMap((item) => (item.hunk_rest === null ? [item.hunk_rest_reason] : [])),
        ).map((reason) => `rest of hunk: ${reason}`),
      ]
      return {
        block,
        shown: `${files} of ${items.length} comments (rest of hunk on ${hunks})`,
        missing: missing.length === 0 ? 'none' : missing.join('; '),
      }
    }
    const reasons =
      block === 'pr_description'
        ? pulls.map((pull) => (pull.description === null ? pull.description_reason : null))
        : pulls.map((pull) => (pull.linked_issue === null ? pull.linked_issue_reason : null))
    const missing = tally(reasons.filter((reason) => reason !== null))
    return {
      block,
      shown: `${reasons.filter((reason) => reason === null).length} of ${pulls.length} pull requests`,
      missing: missing.length === 0 ? 'none' : missing.join('; '),
    }
  })
}

function tally(reasons: (string | undefined)[]): string[] {
  const counts = new Map<string, number>()
  for (const reason of reasons)
    counts.set(reason ?? 'unknown', (counts.get(reason ?? 'unknown') ?? 0) + 1)
  return [...counts.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([reason, count]) => `${reason} ${count}`)
}

// Reads the context the chosen blocks need for the labelled items, one pull request at a time
// in (repository, number) order.
export async function gatherContext(input: {
  client: GitHubClient
  items: DrawnItem[]
  blocks: ReadonlySet<ContextBlock>
  progress?: (line: string) => void
}): Promise<ReplayContext> {
  const pulls = new Map<string, PullContext>()
  const items = new Map<string, ItemContext>()
  const needsPull = input.blocks.has('pr_description') || input.blocks.has('linked_issue')
  const needsCode = input.blocks.has('wider_code')
  for (const [batch, members] of byPull(input.items)) {
    const [first] = members
    if (!first || (!needsPull && !needsCode)) continue
    input.progress?.(`ablate: reading the context of ${batch}`)
    if (needsPull) {
      const at = members.map((item) => item.comment.created_at).sort()[0] ?? ''
      pulls.set(batch, await pullContextAt(input.client, first, at))
    }
    if (needsCode)
      for (const [id, code] of await widerCode(input.client, members)) items.set(id, code)
  }
  return { pulls, items }
}

function byPull(items: DrawnItem[]): [string, DrawnItem[]][] {
  const pulls = new Map<string, DrawnItem[]>()
  for (const item of items) {
    const key = `${item.repository}#${item.pr}`
    pulls.set(key, [...(pulls.get(key) ?? []), item])
  }
  return [...pulls.entries()].sort(([, [a]], [, [b]]) =>
    a && b ? compareText(a.repository, b.repository) || a.pr - b.pr : 0,
  )
}

const PULL_CONTEXT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title
      body
      userContentEdits(first: 100) { totalCount nodes { editedAt diff } }
      timelineItems(
        first: 100
        itemTypes: [RENAMED_TITLE_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT]
      ) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on RenamedTitleEvent { createdAt previousTitle currentTitle }
          ... on ConnectedEvent { createdAt subject { ...LinkedIssue } }
          ... on DisconnectedEvent { createdAt subject { ...LinkedIssue } }
        }
      }
    }
  }
}
fragment LinkedIssue on ReferencedSubject {
  __typename
  ... on Issue { number repository { nameWithOwner } }
}`

const ISSUE_CONTEXT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        title
        body
        createdAt
        userContentEdits(first: 100) { totalCount nodes { editedAt diff } }
        timelineItems(first: 100, itemTypes: [RENAMED_TITLE_EVENT]) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on RenamedTitleEvent { createdAt previousTitle currentTitle }
          }
        }
      }
    }
  }
}`

interface Edits {
  totalCount: number
  nodes: { editedAt: string; diff: string | null }[]
}

interface TimelineNode {
  __typename: string
  createdAt?: string
  previousTitle?: string
  subject?: { __typename: string; number?: number; repository?: { nameWithOwner: string } }
}

interface IssueContextPage {
  repository: {
    issueOrPullRequest: {
      __typename: string
      title?: string
      body?: string | null
      createdAt?: string
      userContentEdits?: Edits
      timelineItems?: { pageInfo: { hasNextPage: boolean }; nodes: TimelineNode[] }
    } | null
  } | null
}

interface IssueRef {
  repository: string
  number: number
}

interface PullContextPage {
  repository: {
    pullRequest: {
      title: string
      body: string | null
      userContentEdits: Edits
      timelineItems: { pageInfo: { hasNextPage: boolean }; nodes: TimelineNode[] }
    } | null
  } | null
}

async function pullContextAt(
  client: GitHubClient,
  item: DrawnItem,
  at: string,
): Promise<PullContext> {
  const page = await graphqlRead<PullContextPage>(
    client,
    PULL_CONTEXT_QUERY,
    item.repository,
    item.pr,
    `the context of ${item.repository}#${item.pr}`,
  )
  const pull = page?.repository?.pullRequest
  if (!pull) return unavailable('pull request unavailable')
  const { timelineItems } = pull
  // GitHub's totalCount counts every timeline item, whatever itemTypes filters, so it says
  // nothing about the filtered events read here; the filtered connection's own page does.
  if (timelineItems.pageInfo.hasNextPage) return unavailable('timeline too long')
  const title = titleAt(pull.title, timelineItems.nodes, at)
  const body = textAt(pull.body, pull.userContentEdits, at)
  if ('reason' in body) return { ...unavailable(body.reason), title }
  const cleaned = cleanBody(body.text ?? '', Number.POSITIVE_INFINITY)
  const description = cut(cleaned, BLOCK_TOKEN_BUDGETS.pr_description)
  const refs = [
    ...keywordIssues(cleaned, item.repository),
    ...sidebarIssues(timelineItems.nodes, at),
  ]
  const issue = await firstLinkedIssue(client, refs, at)
  return {
    title,
    description: description.length === 0 ? null : description,
    ...(description.length === 0 ? { description_reason: 'no description' } : {}),
    ...issue,
  }
}

function unavailable(reason: string): PullContext {
  return {
    title: null,
    description: null,
    description_reason: reason,
    linked_issue: null,
    linked_issue_reason: reason,
  }
}

// GitHub answers a GraphQL read of something missing or invisible with NOT_FOUND errors.
function isGraphqlNotFound(error: unknown): boolean {
  const errors = (error as { errors?: { type?: string }[] }).errors
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((entry) => entry.type === 'NOT_FOUND')
  )
}

async function graphqlRead<T>(
  client: GitHubClient,
  query: string,
  repository: string,
  number: number,
  what: string,
): Promise<T | null> {
  const [owner = '', repo = ''] = repository.split('/')
  try {
    return await client.graphql<T>(query, { owner, repo, number })
  } catch (error) {
    // Something missing, or a repository the token cannot see, reads as nothing.
    if (isGraphqlNotFound(error)) return null
    throw gitHubError(error, what)
  }
}

// GitHub's closing keywords, followed by `#N`, `owner/repo#N` or an issue URL.
const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+))\b/gi

// Issues a description names with a closing keyword, in text order.
export function keywordIssues(description: string, repository: string): IssueRef[] {
  return [...description.matchAll(CLOSING_KEYWORD)].map((match) => ({
    repository: match[1] ?? match[3] ?? repository,
    number: Number(match[2] ?? match[4]),
  }))
}

// Issues linked in the sidebar before a time and still linked then, in the order linked.
function sidebarIssues(timeline: TimelineNode[], at: string): IssueRef[] {
  const linked = new Map<string, IssueRef>()
  const events = timeline
    .filter((node) => !isAfter(node.createdAt ?? '', at))
    .sort((a, b) => compareText(a.createdAt ?? '', b.createdAt ?? ''))
  for (const node of events) {
    const subject = node.subject
    if (subject?.__typename !== 'Issue' || subject.number === undefined || !subject.repository)
      continue
    const ref = { repository: subject.repository.nameWithOwner, number: subject.number }
    const key = `${ref.repository}#${ref.number}`
    if (node.__typename === 'ConnectedEvent') linked.set(key, ref)
    if (node.__typename === 'DisconnectedEvent') linked.delete(key)
  }
  return [...linked.values()]
}

// The first referenced issue that existed at the time, as it read then. A reference to a pull
// request, or to an issue that cannot be read, is skipped.
async function firstLinkedIssue(
  client: GitHubClient,
  refs: IssueRef[],
  at: string,
): Promise<Pick<PullContext, 'linked_issue' | 'linked_issue_reason'>> {
  const seen = new Set<string>()
  for (const ref of refs) {
    const key = `${ref.repository}#${ref.number}`
    if (seen.has(key)) continue
    seen.add(key)
    const issue = await issueAt(client, ref, at)
    if (issue !== null) return { linked_issue: issue }
  }
  return { linked_issue: null, linked_issue_reason: 'no linked issue' }
}

async function issueAt(
  client: GitHubClient,
  ref: IssueRef,
  at: string,
): Promise<{ title: string; body: string } | null> {
  const page = await graphqlRead<IssueContextPage>(
    client,
    ISSUE_CONTEXT_QUERY,
    ref.repository,
    ref.number,
    `the issue ${ref.repository}#${ref.number}`,
  )
  const issue = page?.repository?.issueOrPullRequest
  if (
    issue?.__typename !== 'Issue' ||
    issue.title === undefined ||
    issue.userContentEdits === undefined
  )
    return null
  if (issue.createdAt === undefined || isAfter(issue.createdAt, at)) return null
  const timeline = issue.timelineItems ?? { pageInfo: { hasNextPage: false }, nodes: [] }
  if (timeline.pageInfo.hasNextPage) return null
  const body = textAt(issue.body ?? null, issue.userContentEdits, at)
  if ('reason' in body) return null
  const title = titleAt(issue.title, timeline.nodes, at)
  const budget = Math.max(0, characters(BLOCK_TOKEN_BUDGETS.linked_issue) - title.length)
  return { title, body: cleanBody(body.text ?? '', budget) }
}

function cut(text: string, tokens: number): string {
  return text.slice(0, characters(tokens)).trimEnd()
}

// The wider code of a pull request's comments: each comment's file at the comment's commit,
// windowed around the commented lines, and the rest of its diff hunk from the pull request's
// diff at that commit.
async function widerCode(
  client: GitHubClient,
  members: DrawnItem[],
): Promise<Map<string, ItemContext>> {
  const [first] = members
  const code = new Map<string, ItemContext>()
  if (!first) return code
  const base = await baseSha(client, first.repository, first.pr)
  const patches = new Map<string, CompareFile[] | null>()
  for (const item of [...members].sort((a, b) => compareText(a.id, b.id))) {
    const from = item.evidence.from
    const anchor = item.evidence.anchor
    const file =
      anchor === null
        ? { file: null, file_reason: 'comment on the old side' }
        : fileWindow(await fetchFileText(client, item.repository, item.comment.path, from), anchor)
    if (base !== null && !patches.has(from))
      patches.set(from, await fetchCompareFiles(client, item.repository, base, from))
    const files = base === null ? null : (patches.get(from) ?? null)
    code.set(item.id, { ...file, ...hunkRest(files, item.comment.path, item.comment.diff_hunk) })
  }
  return code
}

// The numbered lines around the commented ones, widening one line at a time on each side
// while the window fits its budget.
function fileWindow(
  text: string | null,
  anchor: { start: number; end: number },
): Pick<ItemContext, 'file' | 'file_reason'> {
  if (text === null) return { file: null, file_reason: 'file unavailable' }
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const end = Math.min(anchor.end, lines.length)
  if (end < 1 || anchor.start > lines.length)
    return { file: null, file_reason: 'anchor outside file' }
  const numbered = (line: number) => {
    const content = lines[line - 1] ?? ''
    const shown =
      content.length > MAX_LINE_CHARACTERS ? `${content.slice(0, MAX_LINE_CHARACTERS)}…` : content
    return `${line}| ${shown}`.trimEnd()
  }
  const budget = characters(BLOCK_TOKEN_BUDGETS.file_window)
  const size = (window: string[]) => window.join('\n').length
  // The commented line is the last of the anchor; a long anchor keeps its end.
  let window: string[] = []
  for (let line = end; line >= Math.max(1, anchor.start); line--) {
    const next = [numbered(line), ...window]
    if (size(next) > budget) break
    window = next
  }
  let low = end - window.length + 1
  let high = end
  let canGrowUp = true
  let canGrowDown = true
  for (let step = 1; step <= WINDOW_LINES_EACH_SIDE; step++) {
    if (canGrowUp && low > 1 && size([numbered(low - 1), ...window]) <= budget) {
      window = [numbered(low - 1), ...window]
      low--
    } else canGrowUp = false
    if (canGrowDown && high < lines.length && size([...window, numbered(high + 1)]) <= budget) {
      window = [...window, numbered(high + 1)]
      high++
    } else canGrowDown = false
  }
  return { file: window.join('\n') }
}

// The lines of the comment's hunk after the commented line, found by the hunk's header in the
// pull request's diff at the comment's commit.
function hunkRest(
  files: CompareFile[] | null,
  path: string,
  diffHunk: string,
): Pick<ItemContext, 'hunk_rest' | 'hunk_rest_reason'> {
  const patch = files?.find((file) => file.filename === path)?.patch
  if (patch === undefined) return { hunk_rest: null, hunk_rest_reason: 'diff unavailable' }
  const [header, ...shown] = diffHunk.replace(/\r\n?/g, '\n').split('\n')
  const hunk = patchHunks(patch).find((candidate) => candidate[0] === header)
  const body = hunk?.slice(1) ?? []
  const isPrefix = shown.every((line, index) => body[index] === line)
  if (!hunk || !isPrefix) return { hunk_rest: null, hunk_rest_reason: 'hunk not found' }
  const rest = body.slice(shown.length)
  if (rest.length === 0) return { hunk_rest: null, hunk_rest_reason: 'comment at the hunk end' }
  const budget = characters(BLOCK_TOKEN_BUDGETS.hunk_rest)
  const kept: string[] = []
  for (const line of rest) {
    if ([...kept, line].join('\n').length > budget) break
    kept.push(line)
  }
  return kept.length === 0
    ? { hunk_rest: null, hunk_rest_reason: 'hunk line too long' }
    : { hunk_rest: kept.join('\n') }
}

// A patch's hunks, each starting with its `@@` header line.
function patchHunks(patch: string): string[][] {
  const hunks: string[][] = []
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('@@')) hunks.push([line])
    else hunks.at(-1)?.push(line)
  }
  return hunks
}

// A title as it read at a time: the previous title of the first rename after it, or the
// current title when it was not renamed since.
export function titleAt(current: string, timeline: TimelineNode[], at: string): string {
  const later = timeline
    .filter((node) => node.__typename === 'RenamedTitleEvent' && isAfter(node.createdAt ?? '', at))
    .sort((a, b) => compareText(a.createdAt ?? '', b.createdAt ?? ''))[0]
  return later?.previousTitle ?? current
}

// A body as it read at a time. GitHub keeps each revision's full text; a body never edited has
// none, and then the current body is the original.
export function textAt(
  current: string | null,
  edits: Edits,
  at: string,
): { text: string | null } | { reason: string } {
  if (edits.totalCount === 0) return { text: current }
  const revision = edits.nodes
    .filter((node) => !isAfter(node.editedAt, at))
    .sort((a, b) => compareText(b.editedAt, a.editedAt))[0]
  if (!revision)
    return {
      reason:
        edits.totalCount > edits.nodes.length
          ? 'edit history too long'
          : 'written after the comment',
    }
  if (revision.diff === null) return { reason: 'revision deleted' }
  return { text: revision.diff }
}

function isAfter(time: string, reference: string): boolean {
  return Date.parse(time) > Date.parse(reference)
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
