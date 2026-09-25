import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { combineHandlers, runCli, type Sandbox } from './helpers/run-cli.js'
import type { RepositorySpec } from './fixtures/github/replay-world.js'
import type { FakeIssue, FakePull } from './helpers/fake-github-replay.js'
import {
  createFakeJev,
  JEV_KEY,
  runReplay,
  setupReplay,
  TOKEN,
  type FakeGitHubReplay,
  type FakeJev,
} from './helpers/replay.js'
import { jevByPart, scoredReplay, WORTH } from './helpers/scored-replay.js'

// The scored replay of the helpers (ten PRs, one comment each, "Comment on part N"), with
// extra world details for the context blocks. PR N's comment was written on 2026-07-(10+N).
function contextReplay(spec: Partial<RepositorySpec> = {}) {
  const setup = setupReplay({
    config: { name: 'public-v1', target_items: 100 },
    specs: [
      {
        name: 'acme/widgets',
        bots: { 'coderabbitai[bot]': 10 },
        body: ({ pr }) => `Comment on part ${pr}`,
        ...spec,
      },
    ],
  })
  return { ...setup, jev: jevByPart(WORTH) }
}

// The request Jev received for the comment on part N.
function requestFor(jev: FakeJev, part: number) {
  const call = jev.calls.find((candidate) => candidate.body.includes(`Comment on part ${part}"`))
  if (!call) throw new Error(`No request for part ${part}`)
  return call.json as {
    state: { pr: Record<string, unknown>; comments: Record<string, Record<string, unknown>> }
    questions: Record<string, { instructions: Record<string, string> }>
  }
}

async function evaluatedReplay(setup = scoredReplay()) {
  await runReplay(['public-v1'], setup.sandbox, setup.gitHub, { jev: setup.jev })
  return setup
}

function writeVariants(sandbox: Sandbox, variants: unknown, name = 'public-v1') {
  sandbox.write(`work/replay/${name}.variants.json`, JSON.stringify(variants))
}

function ablate(argv: string[], sandbox: Sandbox, jev: FakeJev, gitHub?: FakeGitHubReplay) {
  return runCli(['ablate', ...argv], {
    sandbox,
    env: { ...TOKEN, ...JEV_KEY },
    fetch: combineHandlers(
      ...(gitHub ? [{ matches: gitHub.matches, handle: gitHub.handle }] : []),
      { matches: (url) => url.startsWith('https://openrouter.ai/'), handle: jev.handle },
    ),
  })
}

function replayFile(sandbox: Sandbox, name: string) {
  return readFileSync(join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', name), 'utf8')
}

describe('context ablation', () => {
  it("compares a variant with the baseline, served from the replay's own cached requests", async () => {
    const { sandbox } = await evaluatedReplay()
    writeVariants(sandbox, { variants: [{ name: 'wording', blocks: [] }] })
    const result = replayFile(sandbox, 'result.json')
    const manifest = replayFile(sandbox, 'manifest.json')
    // A second real comment now scores below a noise comment: AUROC 23/25 = 0.92.
    const jev = jevByPart({ ...WORTH, 3: 0.38 })

    const run = await ablate(['public-v1'], sandbox, jev)

    expect(run.exitCode).toBe(0)
    // The baseline's requests are byte-identical to the score stage's, so all come from the
    // cache; only the variant's ten requests reach Jev.
    expect(jev.calls).toHaveLength(10)
    expect(run.stdout).toContain('ablation: public-v1\n')
    expect(run.stdout).toMatch(/\n {2}baseline,v0\.1,none,10,0\.96,/)
    expect(run.stdout).toMatch(/\n {2}wording,v0\.1-context\.1,none,10,0\.92,/)
    expect(replayFile(sandbox, 'result.json')).toBe(result)
    expect(replayFile(sandbox, 'manifest.json')).toBe(manifest)
  })
  describe('pull request block', () => {
    it('adds the title and description as they read when the comment was written', async () => {
      const setup = await evaluatedReplay(
        contextReplay({
          pull: (pr) =>
            pr === 1
              ? {
                  title: 'Retry widget sends',
                  renames: [
                    { at: '2026-07-05T00:00:00Z', from: 'WIP', to: 'Add widget retries' },
                    {
                      at: '2026-07-20T00:00:00Z',
                      from: 'Add widget retries',
                      to: 'Retry widget sends',
                    },
                  ],
                  body_history: [
                    { at: '2026-07-01T00:00:00Z', body: 'Adds retries to the widget sender.' },
                    {
                      at: '2026-07-20T00:00:00Z',
                      body: 'Adds retries. Also fixes the null dereference the bot found.',
                    },
                  ],
                }
              : {},
        }),
      )
      writeVariants(setup.sandbox, { variants: [{ name: 'pr', blocks: ['pr_description'] }] })
      const jev = jevByPart(WORTH)

      const run = await ablate(['public-v1'], setup.sandbox, jev, setup.gitHub)

      expect(run.exitCode).toBe(0)
      const request = requestFor(jev, 1)
      expect(request.state.pr).toEqual({
        repository: 'acme/widgets',
        title: 'Add widget retries',
        description: 'Adds retries to the widget sender.',
      })
      expect(request.questions.c1_act?.instructions.pull_request_description).toBe(
        '`pr.description`',
      )
    })

    it('leaves the description and its reference out when the pull request has none', async () => {
      const setup = await evaluatedReplay(contextReplay({ prBody: () => '' }))
      writeVariants(setup.sandbox, { variants: [{ name: 'pr', blocks: ['pr_description'] }] })
      const jev = jevByPart(WORTH)

      await ablate(['public-v1'], setup.sandbox, jev, setup.gitHub)

      const request = requestFor(jev, 1)
      expect(request.state.pr).toEqual({
        repository: 'acme/widgets',
        title: 'Improve widget handling part 1',
      })
      expect(request.questions.c1_act?.instructions).not.toHaveProperty('pull_request_description')
    })
  })
})

describe('linked issue block', () => {
  const ISSUE: Omit<FakeIssue, 'repository'> = {
    number: 70,
    title: 'Widget sends give up too early',
    body: 'Sends fail on the first timeout.',
    created_at: '2026-06-01T00:00:00Z',
  }

  async function linkedReplay(
    pull: (pr: number) => Partial<FakePull>,
    issues: Omit<FakeIssue, 'repository'>[] = [ISSUE],
  ) {
    const setup = await evaluatedReplay(contextReplay({ pull, issues }))
    writeVariants(setup.sandbox, { variants: [{ name: 'issue', blocks: ['linked_issue'] }] })
    const jev = jevByPart(WORTH)
    const run = await ablate(['public-v1'], setup.sandbox, jev, setup.gitHub)
    return { run, jev }
  }

  it('adds the issue a closing keyword named, as it read when the comment was written', async () => {
    const { run, jev } = await linkedReplay(
      (pr) => (pr === 1 ? { body: 'Retry sends.\n\nFixes #70' } : {}),
      [
        {
          ...ISSUE,
          title: 'Sends give up',
          renames: [
            {
              at: '2026-07-30T00:00:00Z',
              from: 'Widget sends give up too early',
              to: 'Sends give up',
            },
          ],
          body_history: [
            { at: '2026-06-01T00:00:00Z', body: 'Sends fail on the first timeout.' },
            { at: '2026-07-30T00:00:00Z', body: 'Fixed by the retry PR.' },
          ],
        },
      ],
    )

    expect(run.exitCode).toBe(0)
    const request = requestFor(jev, 1)
    expect(request.state.pr.linked_issue).toEqual({
      title: 'Widget sends give up too early',
      body: 'Sends fail on the first timeout.',
    })
    // The linked-issue block alone does not show the description it was found in.
    expect(request.state.pr).not.toHaveProperty('description')
    expect(request.questions.c1_act?.instructions.linked_issue).toBe('`pr.linked_issue`')
    expect(requestFor(jev, 2).state.pr).not.toHaveProperty('linked_issue')
    expect(requestFor(jev, 2).questions.c1_act?.instructions).not.toHaveProperty('linked_issue')
    expect(run.stdout).toContain('  linked_issue,1 of 10 pull requests,')
  })

  it('adds an issue linked in the sidebar before the comment, not one linked after it', async () => {
    const { jev } = await linkedReplay((pr) => {
      if (pr === 1) return { connected: [{ at: '2026-07-01T00:00:00Z', issue: 70 }] }
      if (pr === 2) return { connected: [{ at: '2026-07-20T00:00:00Z', issue: 70 }] }
      return {}
    })

    expect(requestFor(jev, 1).state.pr.linked_issue).toEqual({
      title: 'Widget sends give up too early',
      body: 'Sends fail on the first timeout.',
    })
    expect(requestFor(jev, 2).state.pr).not.toHaveProperty('linked_issue')
  })

  it('ignores a closing keyword added after the comment, or naming a pull request or a missing issue', async () => {
    const { jev } = await linkedReplay((pr) => {
      if (pr === 1)
        return {
          body_history: [
            { at: '2026-07-01T00:00:00Z', body: 'Retry sends.' },
            { at: '2026-07-20T00:00:00Z', body: 'Retry sends.\n\nCloses #70' },
          ],
        }
      if (pr === 2) return { body: 'Follow-up. Fixes #3' }
      if (pr === 3) return { body: 'Fixes #999' }
      return {}
    })

    for (const part of [1, 2, 3])
      expect(requestFor(jev, part).state.pr).not.toHaveProperty('linked_issue')
  })
})

describe('wider code block', () => {
  // PR N's comment is on line 10 of src/coderabbitaibot-N-0.ts at commit f-acme-widgets-N;
  // the replay world serves that file (100 lines, "line K") for odd PRs only.
  const path = (pr: number) => `src/coderabbitaibot-${pr}-0.ts`

  async function widerReplay(spec: Partial<RepositorySpec> = {}) {
    const setup = contextReplay(spec)
    await evaluatedReplay(setup)
    writeVariants(setup.sandbox, { variants: [{ name: 'code', blocks: ['wider_code'] }] })
    const jev = jevByPart(WORTH)
    const run = await ablate(['public-v1'], setup.sandbox, jev, setup.gitHub)
    return { run, jev, gitHub: setup.gitHub }
  }

  it("adds the numbered file around the comment at the comment's commit, and the rest of its hunk", async () => {
    const { run, jev } = await widerReplay({
      pull: (pr) => (pr === 1 ? { base_sha: 'b-acme-widgets-1' } : {}),
      compares: {
        'b-acme-widgets-1...f-acme-widgets-1': [
          {
            filename: path(1),
            status: 'modified',
            patch: [
              '@@ -1,3 +1,10 @@',
              '+const value = read()',
              '+use(value)',
              '+check(value)',
              '-return null',
              '+return value',
            ].join('\n'),
          },
        ],
      },
    })

    expect(run.exitCode).toBe(0)
    const comment = requestFor(jev, 1).state.comments.c1
    const lines = Array.from({ length: 70 }, (_, index) => `${index + 1}| line ${index + 1}`)
    expect(comment?.file).toBe(lines.join('\n'))
    expect(comment?.hunk_rest).toBe('+check(value)\n-return null\n+return value')
    expect(requestFor(jev, 1).questions.c1_act?.instructions).toMatchObject({
      surrounding_code: '`comments.c1.file`',
      rest_of_hunk: '`comments.c1.hunk_rest`',
    })
    // PR 2's file cannot be read at its commit and its comparison is missing.
    expect(requestFor(jev, 2).state.comments.c1).not.toHaveProperty('file')
    expect(requestFor(jev, 2).questions.c1_act?.instructions).not.toHaveProperty('surrounding_code')
    expect(requestFor(jev, 2).questions.c1_act?.instructions).not.toHaveProperty('rest_of_hunk')
    expect(run.stdout).toContain(
      '  wider_code,5 of 10 comments (rest of hunk on 1),"file unavailable 5; rest of hunk: diff unavailable 9"',
    )
  })

  it('narrows the window around the commented line to stay within its budget', async () => {
    const long = (line: number) => `line ${line} ${'x'.repeat(80)}`
    const { jev } = await widerReplay({
      contents: {
        [`${path(1)}@f-acme-widgets-1`]: Array.from({ length: 400 }, (_, index) =>
          long(index + 1),
        ).join('\n'),
      },
    })

    const file = String(requestFor(jev, 1).state.comments.c1?.file)
    expect(file.length).toBeLessThanOrEqual(5250)
    expect(file.split('\n')[0]).toBe(`1| ${long(1)}`)
    expect(file).toContain(`\n10| ${long(10)}\n`)
    expect(file.split('\n').length).toBeGreaterThan(40)
  })
})

describe('request size with every block', () => {
  it('keeps every request within the request budget when every block is at its limit', async () => {
    const huge = (label: string) => `${label} ${'word '.repeat(1500)}`
    const setup = contextReplay({
      perPr: 8,
      body: ({ pr, index }) => `${huge(`Comment ${index} on part`)} ${pr}`,
      pull: () => ({ body: `${huge('Description')}\n\nFixes #70` }),
      issues: [{ number: 70, title: 'Widget sends', body: huge('Issue') }],
      contents: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `src/coderabbitaibot-1-${index}.ts@f-acme-widgets-1`,
          Array.from({ length: 400 }, (_, line) => `${line} ${'y'.repeat(120)}`).join('\n'),
        ]),
      ),
    })
    await evaluatedReplay(setup)
    writeVariants(setup.sandbox, {
      variants: [{ name: 'all', blocks: ['pr_description', 'linked_issue', 'wider_code'] }],
    })
    const jev = createFakeJev()

    const run = await ablate(['public-v1'], setup.sandbox, jev, setup.gitHub)

    expect(run.exitCode).toBe(0)
    for (const call of jev.calls)
      expect(Math.ceil(call.body.length / 3.5)).toBeLessThanOrEqual(26_000)
    const state = jev.calls[0]?.json.state as {
      pr: { description: string; linked_issue: { title: string; body: string } }
    }
    expect(state.pr.description.length).toBeLessThanOrEqual(5250)
    expect(
      state.pr.linked_issue.title.length + state.pr.linked_issue.body.length,
    ).toBeLessThanOrEqual(5250)
    // Eight comments with every block do not fit one request: their PR is split by file.
    expect(jev.calls.length).toBeGreaterThan(10)
    expect(run.stdout).toContain('  all,v0.1-context.1,pr_description+linked_issue+wider_code,80,')
  }, 60_000)
})

describe('ablation budget', () => {
  it('shares one --max-cost across every variant, stops cleanly, and resumes paying only for the rest', async () => {
    const { sandbox, gitHub } = await evaluatedReplay()
    writeVariants(sandbox, {
      variants: [
        { name: 'first', blocks: [] },
        { name: 'second', blocks: ['pr_description'] },
      ],
    })
    const jev = jevByPart(WORTH)

    const stopped = await ablate(['public-v1', '--max-cost', '0.0005'], sandbox, jev, gitHub)

    expect(stopped.exitCode).toBe(3)
    expect(stopped.stdout).toContain('stopped: max-cost\n')
    expect(stopped.stdout).toContain('code: BUDGET_STOP\n')
    expect(stopped.stdout).toContain('stopped_in: "second: 3 of 10 items scored"\n')
    expect(stopped.stdout).toContain(
      'Run `quiet-review-axi ablate public-v1 --max-cost 0.5` to resume',
    )
    const paid = jev.calls.length
    expect(paid).toBeGreaterThan(0)
    expect(paid).toBeLessThan(20)

    const resumed = await ablate(['public-v1', '--max-cost', '0.01'], sandbox, jev, gitHub)

    expect(resumed.exitCode).toBe(0)
    expect(jev.calls).toHaveLength(20)
    expect(resumed.stdout).toMatch(/\n {2}second,v0\.1-context\.1,pr_description,10,/)
  })
})

describe('ablation results', () => {
  it("writes each variant's scores and the comparison, logs the run, and compares AUROC per bot", async () => {
    const { sandbox } = await evaluatedReplay()
    writeVariants(sandbox, { variants: [{ name: 'wording', blocks: [] }] })
    const jev = jevByPart({ ...WORTH, 3: 0.38 })

    const run = await ablate(['public-v1'], sandbox, jev)

    expect(run.stdout).toContain(
      'variants[2]{variant,question_pack,blocks,items,auroc,auroc_ci95,auroc_change,auroc_change_ci95,',
    )
    expect(run.stdout).toContain(
      'by_bot[1]{bot,items,real,baseline,wording}:\n  "coderabbitai[bot]",10,5,0.96,0.92\n',
    )
    const result = JSON.parse(replayFile(sandbox, 'ablation/result.json')) as {
      variants: { variant: string; auroc_change: number; auroc_change_ci95: [number, number] }[]
    }
    expect(result.variants.map((variant) => variant.variant)).toEqual(['baseline', 'wording'])
    expect(result.variants[1]?.auroc_change).toBeCloseTo(-0.04, 10)
    expect(result.variants[1]?.auroc_change_ci95[1]).toBeLessThanOrEqual(0)
    expect(replayFile(sandbox, 'ablation/result.json')).not.toContain('Comment on part')
    expect(replayFile(sandbox, 'ablation/scores/wording.jsonl').trim().split('\n')).toHaveLength(10)
    const runs = replayFile(sandbox, 'runs.jsonl').trim().split('\n')
    expect(JSON.parse(runs.at(-1) ?? '{}')).toMatchObject({
      kind: 'ablation',
      replay: 'public-v1',
      variants: ['baseline', 'wording'],
    })
  })

  it('prints the same comparison as one JSON document with --json', async () => {
    const { sandbox } = await evaluatedReplay()
    writeVariants(sandbox, { variants: [{ name: 'wording', blocks: [] }] })

    const run = await ablate(['public-v1', '--json'], sandbox, jevByPart(WORTH))

    const json = JSON.parse(run.stdout) as { ablation: string; variants: { variant: string }[] }
    expect(json.ablation).toBe('public-v1')
    expect(json.variants.map((variant) => variant.variant)).toEqual(['baseline', 'wording'])
  })
})

describe('ablation refusals', () => {
  it('refuses a replay that has not been labelled', async () => {
    const { sandbox } = setupReplay()
    writeVariants(sandbox, { variants: [{ name: 'pr', blocks: ['pr_description'] }] })

    const run = await ablate(['public-v1'], sandbox, jevByPart(WORTH))

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toContain('Replay public-v1 has not been labelled yet')
  })

  it.each([
    [{ variants: [] }, 'variants'],
    [{ variants: [{ name: 'x', blocks: ['diff'] }] }, 'variants.0.blocks.0'],
    [{ variants: [{ name: 'baseline', blocks: [] }] }, 'variants.0.name'],
    [{ variants: [{ name: 'real', blocks: [] }] }, 'variants.0.name'],
    [
      {
        variants: [
          { name: 'x', blocks: [] },
          { name: 'x', blocks: ['wider_code'] },
        ],
      },
      'must not repeat a variant name',
    ],
    [{ variants: [{ name: 'x', blocks: [], pack: 'v0.1' }] }, 'variants.0'],
  ])('refuses an invalid variants file (%j)', async (variants, message) => {
    const { sandbox } = await evaluatedReplay()
    writeVariants(sandbox, variants)
    const jev = jevByPart(WORTH)

    const run = await ablate(['public-v1'], sandbox, jev)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toContain('Invalid variants file replay/public-v1.variants.json')
    expect(run.stdout).toContain(message)
    expect(jev.calls).toHaveLength(0)
  })

  it('refuses a missing variants file, naming where it goes', async () => {
    const { sandbox } = await evaluatedReplay()

    const run = await ablate(['public-v1'], sandbox, jevByPart(WORTH))

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toContain('No variants file at replay/public-v1.variants.json')
  })

  it('refuses a replay config changed after build', async () => {
    const { sandbox } = await evaluatedReplay()
    writeVariants(sandbox, { variants: [{ name: 'wording', blocks: [] }] })
    const path = join(sandbox.cwd, 'replay', 'public-v1.config.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify({ ...config, seed: 1 }))

    const run = await ablate(['public-v1'], sandbox, jevByPart(WORTH))

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toContain('changed after build')
  })
})
