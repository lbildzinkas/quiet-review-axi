import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { combineHandlers, runCli, type Sandbox } from './helpers/run-cli.js'
import type { RepositorySpec } from './fixtures/github/replay-world.js'
import type { FakeIssue, FakePull } from './helpers/fake-github-replay.js'
import {
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
