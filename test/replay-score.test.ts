import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUESTION_PACK_VERSION } from '../src/core/questions.js'
import {
  createFakeJev,
  JEV_KEY,
  readJsonl,
  runCli,
  runReplay,
  setupReplay,
  TOKEN,
} from './helpers/replay.js'

function replayFile(cwd: string, name: string) {
  return join(cwd, '.quiet-review', 'replays', 'public-v1', name)
}

interface RequestState {
  pr: { repository: string; title: string }
  comments: Record<string, { path: string; lines: string; code: string; comment: string }>
}

describe('replay score stage', () => {
  it('scores every labelled item with Jev, one request per pull request', async () => {
    const { sandbox, gitHub } = setupReplay()
    const jev = createFakeJev()

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/score,done,"4 items, 4 calls, \$0\.\d+"/)
    expect(jev.calls).toHaveLength(4)
    const state = jev.calls[0]?.json.state as RequestState
    expect(state.pr).toEqual({
      repository: 'acme/widgets',
      title: expect.stringMatching(/^Improve widget handling part \d+$/),
    })
    expect(Object.values(state.comments)).toEqual([
      {
        path: 'src/coderabbitaibot-3-0.ts',
        lines: '10',
        code: '@@ -1,3 +1,10 @@\n+const value = read()\n+use(value)',
        comment: expect.stringMatching(/^Possible null dereference of `value` \(#\d+\)\.$/),
      },
    ])
    expect(readJsonl(replayFile(sandbox.cwd, 'scores.jsonl'))).toEqual(
      readJsonl(replayFile(sandbox.cwd, 'labels.jsonl')).map((label) => ({
        id: label.id,
        snapshot: 'typesafe/jev-1.13-20260917',
        worth: 0.5,
        category: 'other',
        severity: 1,
        dup_of: null,
      })),
    )
  })

  it('puts the drawn comments of one pull request into one request, in creation order', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 30 },
      specs: [{ name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 }, perPr: 3 }],
    })
    const jev = createFakeJev()

    await runReplay(['public-v1'], sandbox, gitHub, { jev })

    expect(jev.calls).toHaveLength(10)
    for (const call of jev.calls) {
      const comments = (call.json.state as RequestState).comments
      expect(Object.keys(comments)).toEqual(['c1', 'c2', 'c3'])
      // Each pull request's comments share its per-PR file, in creation order.
      const paths = Object.values(comments).map((entry) => entry.path)
      const pr = paths[0]?.match(/^src\/coderabbitaibot-(\d+)-0\.ts$/)?.[1]
      expect(pr).toBeDefined()
      expect(paths).toEqual([
        `src/coderabbitaibot-${pr}-0.ts`,
        `src/coderabbitaibot-${pr}-1.ts`,
        `src/coderabbitaibot-${pr}-2.ts`,
      ])
    }
  })

  it('does not score excluded items', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          comment: ({ pr }) => (pr <= 3 ? { side: 'LEFT' } : {}),
        },
      ],
    })
    const jev = createFakeJev()

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev })

    expect(result.stdout).toContain('label,done,"real 3, noise 4, excluded 3"')
    expect(result.stdout).toMatch(/score,done,"7 items, 7 calls/)
    expect(jev.calls).toHaveLength(7)
  })

  it('treats a re-run with unchanged labels as a no-op', async () => {
    const { sandbox, gitHub } = setupReplay()
    await runReplay(['public-v1'], sandbox, gitHub)

    const again = await runReplay(['public-v1', '--stage', 'score'], sandbox, gitHub)

    expect(again.exitCode).toBe(0)
    expect(again.fetchCalls).toHaveLength(0)
  })

  it('points at evaluating after the score stage completes on its own', async () => {
    const { sandbox, gitHub } = setupReplay()
    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    const scored = await runReplay(['public-v1', '--stage', 'score'], sandbox, gitHub)

    expect(scored.exitCode).toBe(0)
    expect(scored.stdout).toContain('score,done')
    expect(scored.stdout).not.toContain('evaluate,done')
    expect(scored.stdout).toContain(
      'Run `quiet-review-axi replay public-v1` to evaluate the pre-registered pass rule',
    )
    expect(scored.stdout).not.toContain('--stage label')
  })

  it('stops at --max-cost with exit 3, and a re-run resumes paying only for the rest', async () => {
    const { sandbox, gitHub } = setupReplay()
    const jev = createFakeJev()
    // The label check runs before scoring and would stop first at --max-cost 0.
    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    const stopped = await runReplay(['public-v1', '--max-cost', '0'], sandbox, gitHub, { jev })
    const resumed = await runReplay(['public-v1'], sandbox, gitHub, { jev })

    expect(stopped.exitCode).toBe(3)
    expect(stopped.stdout).toContain('score,stopped,0 of 4 items scored; --max-cost 0 reached')
    expect(stopped.stdout).toContain('Run `quiet-review-axi replay public-v1 --max-cost')
    expect(jev.calls).toHaveLength(4)
    expect(resumed.exitCode).toBe(0)
    expect(resumed.stdout).toMatch(/score,done,"4 items, 4 calls/)
  })

  it('needs a Jev key, and keeps the completed build and label stages', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runCli(['replay', 'public-v1'], {
      sandbox,
      env: TOKEN,
      fetch: gitHub.handle,
    })
    const label = await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: MISSING_KEY')
    expect(label.stdout).toContain('build,done')
    expect(label.stdout).toContain('label,done')
    expect(label.fetchCalls).toHaveLength(0)
  })

  it('refuses score before label, and scores with the TypeSafe provider on request', async () => {
    const { sandbox, gitHub } = setupReplay()
    const early = await runReplay(['public-v1', '--stage', 'score'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    const jev = createFakeJev()

    const typesafe = await runCli(
      ['replay', 'public-v1', '--stage', 'score', '--provider', 'typesafe'],
      { sandbox, env: { TYPESAFE_API_KEY: 'ts-secret' }, fetch: jev.handle },
    )

    expect(early.exitCode).toBe(2)
    expect(early.stdout).toContain('--stage label')
    expect(typesafe.exitCode).toBe(0)
    expect(jev.calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('never prints or logs the Jev key or the GitHub token', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runReplay(['public-v1', '--json'], sandbox, gitHub)

    const written = [result.stdout, result.stderr, ...sandbox.writtenFiles().map((f) => f.content)]
    for (const secret of [JEV_KEY.OPENROUTER_API_KEY, TOKEN.GITHUB_TOKEN])
      expect(written.filter((text) => text.includes(secret))).toEqual([])
  })
})

describe('replay score stage and the question pack', () => {
  it('records the pack version, and refuses to re-score a replay with another pack', async () => {
    const { sandbox, gitHub } = setupReplay()
    await runReplay(['public-v1'], sandbox, gitHub)
    const manifestPath = replayFile(sandbox.cwd, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.stages.score.question_pack).toBe(QUESTION_PACK_VERSION)
    // As if an older build scored it with pack v0.0, and the labels have changed since.
    manifest.stages.score.question_pack = 'v0.0'
    manifest.stages.score.input_hash = 'sha256:older-labels'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const result = await runReplay(['public-v1', '--stage', 'score'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain(
      `scored with question pack v0.0; this build carries ${QUESTION_PACK_VERSION}`,
    )
    expect(result.stdout).toContain('quiet-review-axi gate public-v1')
    expect(result.fetchCalls).toHaveLength(0)
  })
})
