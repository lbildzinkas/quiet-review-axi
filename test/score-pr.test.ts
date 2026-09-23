import { describe, expect, it } from 'vitest'
import { COMMENTS, JEV_ITEMS, PULL, REPOSITORY } from './fixtures/github/acme-widgets-412.js'
import { createFakeGitHub, type FakeGitHubOptions } from './helpers/fake-github.js'
import { createFakeJev, type FakeJevOptions } from './helpers/fake-jev.js'
import { combineHandlers, runCli, type RunOptions, type Sandbox } from './helpers/run-cli.js'

const PR_URL = 'https://github.com/acme/widgets/pull/412'
const SECRETS = { OPENROUTER_API_KEY: 'sk-or-v1-secret-key', GITHUB_TOKEN: 'ghp_secret_token' }

function network(jevOptions: FakeJevOptions = {}, gitHubOptions: Partial<FakeGitHubOptions> = {}) {
  const jev = createFakeJev({ items: JEV_ITEMS, cost: () => 0.000183, ...jevOptions })
  const gitHub = createFakeGitHub({
    pulls: { 'acme/widgets#412': { repository: REPOSITORY, pull: PULL, comments: COMMENTS } },
    ...gitHubOptions,
  })
  const jevRoute = {
    matches: (url: string) => !url.startsWith('https://api.github.com/'),
    handle: jev.handle,
  }
  return { jev, gitHub, fetch: combineHandlers(gitHub, jevRoute) }
}

async function score(args: string[], options: RunOptions & { sandbox?: Sandbox } = {}) {
  const net = network()
  const result = await runCli(['score', ...args], {
    fetch: net.fetch,
    ...options,
    env: { ...SECRETS, ...options.env },
  })
  return { ...result, ...net }
}

describe('score <pr-url>', () => {
  it('prints keep and unsure rows with text and collapsed items as ids, per spec 4.4', async () => {
    const result = await score([PR_URL])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      [
        'pr: acme/widgets#412',
        'title: Add retry to webhook sender',
        'verdicts: "keep 2, unsure 2, collapse 5"',
        'cutoffs: "collapse<0.30 keep>=0.70 (built-in, uncalibrated)"',
        'provider: openrouter',
        'model: typesafe/jev-1.13-20260917',
        'calls: 1',
        'cost_usd: 0.000183',
        'cached: false',
        'keep[2]{id,worth,category,severity,author,path,line,text}:',
        '  c2,0.78,security,3.6,"greptile-apps[bot]",src/webhook.ts,41,Signing secret is written to the debug log on line 41.',
        '  c1,0.91,bug,3.2,"coderabbitai[bot]",src/webhook.ts,88,"Retry loop never resets `attempt`, so after the first failure every later send gives up immediately. Reset it per messag…"',
        'unsure[2]{id,worth,category,severity,author,path,line,text}:',
        '  c3,0.55,performance,2.1,"coderabbitai[bot]",src/queue.ts,17,Consider batching these inserts.',
        '  c4,0.41,docs,1.4,alice,README.md,12,Should mention the new env var here',
        'collapse[5]{id,worth,category,dup_of}:',
        '  c5,0.12,style,none',
        '  c6,0.08,nit,none',
        '  c7,0.21,bug,c1',
        '  c8,0.06,wrong,none',
        '  c9,0.1,nit,none',
        'help[2]:',
        "  Run `quiet-review-axi score acme/widgets#412 --all` to see the collapsed comments' text",
        '  Run `quiet-review-axi score acme/widgets#412 --json` for raw answers and run facts',
        '',
      ].join('\n'),
    )
  })

  it('prints a readable summary with --human, per spec 4.4', async () => {
    const result = await score([PR_URL, '--human'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      [
        'acme/widgets#412  Add retry to webhook sender',
        '9 review comments: 2 worth acting on, 2 unsure, 5 collapsed',
        'Cut-offs: built-in, not yet calibrated. Scored by typesafe/jev-1.13-20260917 in 1 call ($0.0002).',
        '',
        'KEEP',
        '  src/webhook.ts:41   security, severe   greptile-apps[bot]',
        '    Signing secret is written to the debug log on line 41.',
        '  src/webhook.ts:88   bug, moderate      coderabbitai[bot]',
        '    Retry loop never resets `attempt`, so after the first failure every later send gives up immediately. Reset it per messag…',
        '    Also raised by greptile-apps[bot] at src/webhook.ts:90 (collapsed)',
        '',
        'UNSURE (shown, not collapsed)',
        '  src/queue.ts:17     performance        coderabbitai[bot]',
        '  README.md:12        docs               alice',
        '',
        'COLLAPSED (5): 2 nit, 1 style, 1 wrong claim, 1 duplicate',
        '',
      ].join('\n'),
    )
  })

  it('emits one JSON document with run facts and every item with its raw answers', async () => {
    const result = await score([PR_URL, '--json'])
    const document = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(0)
    expect(document).toMatchObject({
      pr: 'acme/widgets#412',
      title: 'Add retry to webhook sender',
      verdicts: 'keep 2, unsure 2, collapse 5',
      cutoffs: 'collapse<0.30 keep>=0.70 (built-in, uncalibrated)',
      provider: 'openrouter',
      model: 'typesafe/jev-1.13-20260917',
      calls: 1,
      cost_usd: 0.000183,
      cached: false,
      run: {
        provider: 'openrouter',
        model_requested: 'typesafe/jev-1.13',
        model_returned: ['typesafe/jev-1.13-20260917'],
        request_ids: ['gen-dec-1'],
        cached: false,
        question_pack: 'v0.1',
        questions: 35,
        cost_usd: 0.000183,
        retries: 0,
      },
    })
    expect(document.run.cache_keys).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)])
    expect(document.run.input_tokens).toBeGreaterThan(0)
    expect(
      document.items.map((item: { id: string; verdict: string }) => `${item.id}:${item.verdict}`),
    ).toEqual([
      'c1:keep',
      'c2:keep',
      'c3:unsure',
      'c4:unsure',
      'c5:collapse',
      'c6:collapse',
      'c7:collapse',
      'c8:collapse',
      'c9:collapse',
    ])
    expect(document.items[6]).toEqual({
      id: 'c7',
      verdict: 'collapse',
      worth: 0.21,
      category: 'bug',
      category_confident: true,
      severity: 3,
      dup_of: 'c1',
      author: 'greptile-apps[bot]',
      path: 'src/webhook.ts',
      line: 90,
      url: 'https://github.com/acme/widgets/pull/412#discussion_r1007',
      context: 'hunk',
      text: 'The retry counter is never reset between messages.',
      answers: {
        act: { type: 'noul', noul: 0.21 },
        cat: expect.objectContaining({ type: 'choice', choice: 'bug' }),
        sev: expect.objectContaining({ type: 'score', score: 3 }),
        dup: expect.objectContaining({ type: 'choice', choice: 'c1' }),
      },
    })
    expect(document.items[0].text).toBe(
      'Retry loop never resets `attempt`, so after the first failure every later send gives up immediately. Reset it per message before the loop starts.',
    )
  })

  it('refuses --json together with --human', async () => {
    const result = await score([PR_URL, '--json', '--human'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.fetchCalls).toEqual([])
  })

  it('expands every row with --all, printing each duplicate directly after the item it repeats', async () => {
    const result = await score([PR_URL, '--all'])

    expect(result.stdout).toContain(
      [
        'items[9]{id,verdict,worth,category,severity,dup_of,author,path,line,text}:',
        '  c2,keep,0.78,security,3.6,none,"greptile-apps[bot]",src/webhook.ts,41,Signing secret is written to the debug log on line 41.',
        '  c1,keep,0.91,bug,3.2,none,"coderabbitai[bot]",src/webhook.ts,88,"Retry loop never resets `attempt`, so after the first failure every later send gives up immediately. Reset it per messag…"',
        '  c7,collapse,0.21,bug,3,c1,"greptile-apps[bot]",src/webhook.ts,90,The retry counter is never reset between messages.',
        '  c3,unsure,0.55,performance,2.1,none,"coderabbitai[bot]",src/queue.ts,17,Consider batching these inserts.',
        '  c4,unsure,0.41,docs,1.4,none,alice,README.md,12,Should mention the new env var here',
        '  c5,collapse,0.12,style,1,none,"coderabbitai[bot]",src/webhook.ts,83,Prefer a named constant for the retry limit.',
        '  c6,collapse,0.08,nit,0.4,none,"coderabbitai[bot]",src/queue.ts,20,Trailing whitespace.',
        '  c8,collapse,0.06,wrong,0.2,none,"copilot-pull-request-reviewer[bot]",src/queue.ts,30,This function is missing a return statement.',
        '  c9,collapse,0.1,nit,0.3,none,"coderabbitai[bot]",src/queue.ts,5,"Typo in comment: \\"recieve\\"."',
        'help[1]:',
      ].join('\n'),
    )
    expect(result.stdout).not.toContain('keep[')
  })

  it('prints a shown duplicate directly after the earlier row it repeats, in the default view', async () => {
    const net = network({
      items: { ...JEV_ITEMS, c5: { act: 0.6, cat: 'bug', sev: 1, dup: { c3: 0.8, none: 0.2 } } },
    })

    const result = await runCli(['score', PR_URL], { fetch: net.fetch, env: SECRETS })

    expect(result.stdout).toMatch(/unsure\[3\][^\n]*\n {2}c3,[^\n]*\n {2}c5,[^\n]*\n {2}c4,/)
  })

  it('prints whole comment bodies with --full', async () => {
    const result = await score([PR_URL, '--full'])

    expect(result.stdout).toContain('Reset it per message before the loop starts."')
  })

  it('marks a category whose top probability is below 0.60 with a question mark', async () => {
    const net = network({
      items: { ...JEV_ITEMS, c5: { act: 0.12, cat: { style: 0.55, nit: 0.45 } } },
    })

    const result = await runCli(['score', PR_URL], { fetch: net.fetch, env: SECRETS })

    expect(result.stdout).toContain('  c5,0.12,style?,none')
  })

  it('scores only human or only bot comments with --authors, keeping ids stable', async () => {
    const humans = await score([PR_URL, '--authors', 'humans', '--json'])
    const bots = await score([PR_URL, '--authors', 'bots', '--json'])

    expect(JSON.parse(humans.stdout).items.map((item: { id: string }) => item.id)).toEqual(['c4'])
    expect(JSON.parse(bots.stdout).items.map((item: { id: string }) => item.id)).toEqual([
      'c1',
      'c2',
      'c3',
      'c5',
      'c6',
      'c7',
      'c8',
      'c9',
    ])
  })

  it('accepts the short owner/repo#n form and URLs with a trailing path', async () => {
    const short = await score(['acme/widgets#412'])
    const files = await score([`${PR_URL}/files`])

    expect(short.stdout).toContain('pr: acme/widgets#412')
    expect(files.stdout).toBe(short.stdout)
  })

  it('rejects an unparsable pull request reference before any request', async () => {
    const result = await score(['https://gitlab.com/acme/widgets/-/merge_requests/1'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.fetchCalls).toEqual([])
  })
})
