// Hand-written GitHub REST responses shaped like the spec 4.4 example pull request.
// Field names follow the real API; payloads are trimmed to what Quiet Review reads.

export const REPOSITORY = { full_name: 'acme/widgets', private: false, visibility: 'public' }

export const PULL = {
  number: 412,
  title: 'Add retry to webhook sender',
  state: 'open',
  html_url: 'https://github.com/acme/widgets/pull/412',
  head: { sha: 'headsha' },
}

const bot = (login: string) => ({ login, type: 'Bot' })
const human = (login: string) => ({ login, type: 'User' })

const HUNK_WEBHOOK = [
  '@@ -80,9 +80,14 @@ export async function send(message: Message) {',
  '   const body = JSON.stringify(message)',
  '+  let attempt = 0',
  '+  for (;;) {',
  '+    attempt++',
].join('\n')

interface CommentSpec {
  id: number
  user: { login: string; type: string }
  body: string
  path: string
  line: number
  start_line?: number
  created_at: string
  in_reply_to_id?: number
}

function comment(spec: CommentSpec) {
  return {
    id: spec.id,
    user: spec.user,
    body: spec.body,
    path: spec.path,
    line: spec.line,
    start_line: spec.start_line ?? null,
    original_line: spec.line,
    original_start_line: spec.start_line ?? null,
    diff_hunk: HUNK_WEBHOOK,
    created_at: spec.created_at,
    in_reply_to_id: spec.in_reply_to_id,
    html_url: `https://github.com/acme/widgets/pull/412#discussion_r${spec.id}`,
    commit_id: 'headsha',
    original_commit_id: 'firstsha',
  }
}

export const RETRY_BODY =
  'Retry loop never resets `attempt`, so after the first failure every later send gives up immediately. Reset it per message before the loop starts.'

export const COMMENTS = [
  comment({
    id: 1001,
    user: bot('coderabbitai[bot]'),
    body: `${RETRY_BODY}\n\n<!-- fingerprinting:phantom:triton -->`,
    path: 'src/webhook.ts',
    start_line: 86,
    line: 88,
    created_at: '2026-09-20T10:00:00Z',
  }),
  comment({
    id: 1002,
    user: bot('greptile-apps[bot]'),
    body: 'Signing secret is written to the debug log on line 41.',
    path: 'src/webhook.ts',
    line: 41,
    created_at: '2026-09-20T10:01:00Z',
  }),
  comment({
    id: 1003,
    user: bot('coderabbitai[bot]'),
    body: 'Consider batching these inserts.',
    path: 'src/queue.ts',
    line: 17,
    created_at: '2026-09-20T10:02:00Z',
  }),
  comment({
    id: 1004,
    user: human('alice'),
    body: 'Should mention the new env var here',
    path: 'README.md',
    line: 12,
    created_at: '2026-09-20T10:03:00Z',
  }),
  comment({
    id: 1005,
    user: bot('coderabbitai[bot]'),
    body: 'Prefer a named constant for the retry limit.',
    path: 'src/webhook.ts',
    line: 83,
    created_at: '2026-09-20T10:04:00Z',
  }),
  comment({
    id: 1006,
    user: bot('coderabbitai[bot]'),
    body: 'Trailing whitespace.',
    path: 'src/queue.ts',
    line: 20,
    created_at: '2026-09-20T10:05:00Z',
  }),
  comment({
    id: 1007,
    user: bot('greptile-apps[bot]'),
    body: 'The retry counter is never reset between messages.',
    path: 'src/webhook.ts',
    line: 90,
    created_at: '2026-09-20T10:06:00Z',
  }),
  comment({
    id: 1008,
    user: bot('copilot-pull-request-reviewer[bot]'),
    body: 'This function is missing a return statement.',
    path: 'src/queue.ts',
    line: 30,
    created_at: '2026-09-20T10:07:00Z',
  }),
  comment({
    id: 1009,
    user: bot('coderabbitai[bot]'),
    body: 'Typo in comment: "recieve".',
    path: 'src/queue.ts',
    line: 5,
    created_at: '2026-09-20T10:08:00Z',
  }),
  // A reply is evidence for the replay, never an item to score.
  comment({
    id: 1010,
    user: human('bob'),
    body: 'Good catch, fixed.',
    path: 'src/webhook.ts',
    line: 88,
    created_at: '2026-09-20T11:00:00Z',
    in_reply_to_id: 1001,
  }),
]

// Scripted Jev answers per item key; keys follow creation order (c1 = comment 1001).
export const JEV_ITEMS = {
  c1: { act: 0.91, cat: 'bug', sev: 3.2 },
  c2: { act: 0.78, cat: 'security', sev: 3.6 },
  c3: { act: 0.55, cat: 'performance', sev: 2.1 },
  c4: { act: 0.41, cat: 'docs', sev: 1.4 },
  c5: { act: 0.12, cat: 'style', sev: 1 },
  c6: { act: 0.08, cat: 'nit', sev: 0.4 },
  c7: { act: 0.21, cat: 'bug', sev: 3, dup: { c1: 0.93, none: 0.07 } },
  c8: { act: 0.06, cat: 'wrong', sev: 0.2 },
  c9: { act: 0.1, cat: 'nit', sev: 0.3 },
}
