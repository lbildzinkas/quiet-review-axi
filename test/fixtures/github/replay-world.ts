// Synthetic public-replay data: repositories whose merged pull requests carry inline comments
// from review bots. Everything is generated from small specs so each test states only what it
// varies. Field names follow the real GitHub API.
import type {
  FakeComment,
  FakeCompareFile,
  FakePull,
  FakeReplayWorld,
  FakeRepository,
} from '../../helpers/fake-github-replay.js'

export const WINDOW = { merged_after: '2026-06-25', merged_before: '2026-09-23' }

export interface CommentContext {
  repository: string
  bot: string
  pr: number
  index: number
  id: number
}

export interface RepositorySpec {
  name: string
  // Merged pull requests inside the window (default 30, the "busy" minimum).
  merged?: number
  // Bots and how many of the merged pull requests (from #1 up) each commented on.
  bots: Record<string, number>
  // Inline root comments per bot per pull request (default 1).
  perPr?: number
  repository?: Partial<FakeRepository>
  title?: (pr: number) => string
  mergedAt?: (pr: number) => string | null
  // Whether the author changed the commented lines before merge (default: odd pull requests).
  changed?: (comment: CommentContext) => boolean
  // Which 403 body shape the contents endpoint returns for the commented file.
  oversized?: (comment: CommentContext) => 'code' | 'message' | undefined
  // Extra thread replies and resolution for a comment.
  replies?: (comment: CommentContext) => { login: string; type?: string; body: string }[]
  resolved?: (comment: CommentContext) => boolean
  // Who resolved each thread (GraphQL `resolvedBy`), by login.
  resolvedBy?: (comment: CommentContext) => string | undefined
  // The pull request's commits in order (default: the comment's commit, then the head).
  commits?: (pr: number) => { sha: string; subject: string }[]
  // Follow-up commits on the base branch after the merge that change the commented line
  // (default date: two days after the default merge time; default patch: the commented
  // line modified).
  followUps?: (
    comment: CommentContext,
  ) => { sha: string; subject: string; at?: string; patch?: string }[]
  // The pull request's body.
  prBody?: (pr: number) => string | null
  body?: (comment: CommentContext) => string
  // Field overrides for a root comment, for example to drop its line anchor.
  comment?: (comment: CommentContext) => Partial<FakeComment>
  // The comparison entry for the comment's file, replacing the `changed` default.
  compareFile?: (comment: CommentContext, path: string) => FakeCompareFile | null
}

export const COMMENT_LINE = 10
export const FILE_LINES = 100

export function config(overrides: Record<string, unknown> = {}) {
  return {
    name: 'public-v1',
    window: WINDOW,
    repositories: ['acme/widgets'],
    bots: ['coderabbitai[bot]'],
    target_items: 4,
    max_share_per_repository: 1,
    max_share_per_bot: 1,
    max_items_per_pr: 8,
    seed: 20260923,
    label_check: { sample_size: 60, model: 'example/label-model' },
    pass_rule: { min_auroc: 0.75, min_noise_collapsed: 0.4, max_real_hidden: 0.05 },
    ...overrides,
  }
}

export function buildWorld(specs: RepositorySpec[]): FakeReplayWorld {
  const world: Required<FakeReplayWorld> = {
    repositories: [],
    pulls: [],
    compares: {},
    contents: {},
  }
  specs.forEach((spec, repositoryIndex) => {
    world.repositories.push({ full_name: spec.name, ...spec.repository })
    const slug = spec.name.replace('/', '-')
    const merged = spec.merged ?? 30
    const lastPr = Math.max(merged, ...Object.values(spec.bots))
    for (let pr = 1; pr <= lastPr; pr++) {
      const from = `f-${slug}-${pr}`
      const to = `h-${slug}-${pr}`
      const pull: FakePull = {
        repository: spec.name,
        number: pr,
        title: spec.title?.(pr) ?? `Improve widget handling part ${pr}`,
        merged_at: spec.mergedAt ? spec.mergedAt(pr) : pr <= merged ? '2026-08-01T12:00:00Z' : null,
        head_sha: to,
        body: spec.prBody?.(pr) ?? 'Makes widget handling more robust.',
        base: 'main',
        merge_commit_sha: `m-${slug}-${pr}`,
        commits: spec.commits?.(pr) ?? [
          { sha: from, subject: `Start widget handling part ${pr}` },
          { sha: to, subject: `Finish widget handling part ${pr}` },
        ],
        comments: [],
        resolved: {},
        resolved_by: {},
        followUps: [],
      }
      const files: FakeCompareFile[] = []
      let nextReply = 50
      Object.entries(spec.bots).forEach(([bot, count], botIndex) => {
        if (pr > count) return
        for (let index = 0; index < (spec.perPr ?? 1); index++) {
          const id = (repositoryIndex + 1) * 1_000_000 + pr * 1000 + botIndex * 100 + index
          const context: CommentContext = { repository: spec.name, bot, pr, index, id }
          // One file per pull request, so a follow-up on one PR's file never reads as a
          // follow-up on another's.
          const path = `src/${bot.replace(/\W/g, '')}-${pr}-${index}.ts`
          pull.comments.push({
            ...rootComment({ id, bot, path, from, pr, index, body: spec.body }),
            ...spec.comment?.(context),
          })
          for (const reply of spec.replies?.(context) ?? []) {
            pull.comments.push({
              ...rootComment({ id: id + nextReply++, bot, path, from, pr, index }),
              user: { login: reply.login, type: reply.type ?? 'User' },
              body: reply.body,
              in_reply_to_id: id,
            })
          }
          if (pull.resolved) pull.resolved[id] = spec.resolved?.(context) ?? false
          const resolver = spec.resolvedBy?.(context)
          if (pull.resolved_by && resolver !== undefined) pull.resolved_by[id] = resolver
          for (const followUp of spec.followUps?.(context) ?? []) {
            pull.followUps?.push({
              sha: followUp.sha,
              subject: followUp.subject,
              at: followUp.at ?? '2026-08-03T12:00:00Z',
              path,
              patch:
                followUp.patch ??
                [
                  `@@ -${COMMENT_LINE - 1},3 +${COMMENT_LINE - 1},3 @@`,
                  ` line ${COMMENT_LINE - 1}`,
                  `-line ${COMMENT_LINE}`,
                  `+line ${COMMENT_LINE} fixed upstream`,
                  ` line ${COMMENT_LINE + 1}`,
                ].join('\n'),
            })
          }
          if (spec.compareFile) {
            const file = spec.compareFile(context, path)
            if (file) files.push(file)
            continue
          }
          const isChanged = spec.changed ? spec.changed(context) : pr % 2 === 1
          if (isChanged) {
            files.push(modifiedAt(path, COMMENT_LINE))
            const oversize = spec.oversized?.(context)
            world.contents[`${spec.name}:${path}@${from}`] =
              oversize === undefined ? fileText(FILE_LINES) : { tooLarge: oversize }
          }
        }
      })
      world.pulls.push(pull)
      world.compares[`${spec.name}:${from}...${to}`] = { files }
    }
  })
  return world
}

function rootComment(options: {
  id: number
  bot: string
  path: string
  from: string
  pr: number
  index: number
  body?: (comment: CommentContext) => string
}): FakeComment {
  const context = {
    repository: '',
    bot: options.bot,
    pr: options.pr,
    index: options.index,
    id: options.id,
  }
  return {
    id: options.id,
    user: { login: options.bot, type: 'Bot' },
    body: options.body?.(context) ?? `Possible null dereference of \`value\` (#${options.id}).`,
    path: options.path,
    line: COMMENT_LINE,
    original_line: COMMENT_LINE,
    diff_hunk: `@@ -1,3 +1,${COMMENT_LINE} @@\n+const value = read()\n+use(value)`,
    created_at: `2026-07-${String(10 + (options.pr % 18)).padStart(2, '0')}T10:${String(options.index).padStart(2, '0')}:00Z`,
    original_commit_id: options.from,
  }
}

// A one-line modification at `line`, the smallest change that counts as "changed".
export function modifiedAt(path: string, line: number): FakeCompareFile {
  return {
    filename: path,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: `@@ -${line - 1},3 +${line - 1},3 @@\n line ${line - 1}\n-line ${line}\n+line ${line} fixed\n line ${line + 1}`,
  }
}

export function fileText(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n')
}
