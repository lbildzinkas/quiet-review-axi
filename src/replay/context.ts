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
  // Why the title and description are not shown, when they are not.
  description_reason?: string
}

export interface ReplayContext {
  // Keyed by `owner/repo#number`, the batch key of the score stage.
  pulls: Map<string, PullContext>
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
  if (!input.blocks.has('pr_description')) return { pulls }
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
      timelineItems(first: 100, itemTypes: [RENAMED_TITLE_EVENT]) {
        totalCount
        nodes {
          __typename
          ... on RenamedTitleEvent { createdAt previousTitle currentTitle }
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
  const [owner = '', repo = ''] = item.repository.split('/')
  let page: PullContextPage
  try {
    page = await client.graphql<PullContextPage>(PULL_CONTEXT_QUERY, {
      owner,
      repo,
      number: item.pr,
    })
  } catch (error) {
    throw gitHubError(error, `the context of ${item.repository}#${item.pr}`)
  }
  const pull = page.repository?.pullRequest
  if (!pull)
    return { title: null, description: null, description_reason: 'pull request unavailable' }
  const { timelineItems } = pull
  if (timelineItems.totalCount > timelineItems.nodes.length)
    return { title: null, description: null, description_reason: 'timeline too long' }
  const title = titleAt(pull.title, timelineItems.nodes, at)
  const body = textAt(pull.body, pull.userContentEdits, at)
  if ('reason' in body) return { title, description: null, description_reason: body.reason }
  const description = cleanBody(body.text ?? '', characters(BLOCK_TOKEN_BUDGETS.pr_description))
  if (description.length === 0)
    return { title, description: null, description_reason: 'no description' }
  return { title, description }
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
