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
})
