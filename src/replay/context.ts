import { cleanBody } from '../core/items.js'
import { gitHubError, type GitHubClient } from '../inputs/github.js'
import type { DrawnItem } from './build.js'
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
} as const

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

export interface ReplayContext {
  // Keyed by `owner/repo#number`, the batch key of the score stage.
  pulls: Map<string, PullContext>
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
  return blocks.map((block) => {
    const pulls = [...context.pulls.values()]
    const reasons =
      block === 'pr_description'
        ? pulls.map((pull) => (pull.description === null ? pull.description_reason : null))
        : pulls.map((pull) => (pull.linked_issue === null ? pull.linked_issue_reason : null))
    const missing = tally(reasons.filter((reason) => reason !== null))
    const shown = reasons.filter((reason) => reason === null).length
    return {
      block,
      shown: `${shown} of ${pulls.length} pull requests`,
      missing: missing.length === 0 ? 'none' : missing.join(', '),
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
  if (!input.blocks.has('pr_description') && !input.blocks.has('linked_issue')) return { pulls }
  for (const [batch, members] of byPull(input.items)) {
    const [first] = members
    if (!first) continue
    input.progress?.(`ablate: reading the context of ${batch}`)
    const at = members.map((item) => item.comment.created_at).sort()[0] ?? ''
    pulls.set(batch, await pullContextAt(input.client, first, at))
  }
  return { pulls }
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
        totalCount
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
          totalCount
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
      timelineItems?: { totalCount: number; nodes: TimelineNode[] }
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
      timelineItems: { totalCount: number; nodes: TimelineNode[] }
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
  if (timelineItems.totalCount > timelineItems.nodes.length) return unavailable('timeline too long')
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
  const timeline = issue.timelineItems ?? { totalCount: 0, nodes: [] }
  if (timeline.totalCount > timeline.nodes.length) return null
  const body = textAt(issue.body ?? null, issue.userContentEdits, at)
  if ('reason' in body) return null
  const title = titleAt(issue.title, timeline.nodes, at)
  const budget = Math.max(0, characters(BLOCK_TOKEN_BUDGETS.linked_issue) - title.length)
  return { title, body: cleanBody(body.text ?? '', budget) }
}

function cut(text: string, tokens: number): string {
  return text.slice(0, characters(tokens)).trimEnd()
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
