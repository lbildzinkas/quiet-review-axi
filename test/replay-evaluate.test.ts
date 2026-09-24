import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUESTION_PACK_VERSION } from '../src/core/questions.js'
import { createFakeJev, readJsonl, runReplay, setupReplay } from './helpers/replay.js'
import type { Sandbox } from './helpers/run-cli.js'

const SNAPSHOT = 'typesafe/jev-1.13-20260917'

// Ten merged PRs with one comment each: the odd ones changed the commented lines (real),
// the even ones did not (noise). Each body says which, so the fake Jev can score it.
function tenPullRequests() {
  return setupReplay({
    config: { target_items: 100 },
    specs: [
      {
        name: 'acme/widgets',
        bots: { 'coderabbitai[bot]': 10 },
        body: ({ pr }) => `${pr % 2 === 1 ? 'Real' : 'Noise'} comment on part ${pr}`,
      },
    ],
  })
}

// Scores real comments `real` and noise comments `noise`.
function jevScoring(
  real: number,
  noise: number,
  options: Parameters<typeof createFakeJev>[0] = {},
) {
  return createFakeJev({
    ...options,
    byComment: (comment) => ({ act: comment.startsWith('Real') ? real : noise }),
  })
}

function replayPath(sandbox: Sandbox, name: string) {
  return join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', name)
}

function userConfigPath(sandbox: Sandbox) {
  return join(sandbox.env.XDG_CONFIG_HOME, 'quiet-review-axi', 'config.json')
}

describe('replay evaluate stage', () => {
  it('passes on the measured values and writes the calibrated cut-offs with provenance', async () => {
    const { sandbox, gitHub } = tenPullRequests()

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev: jevScoring(0.9, 0.1) })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('evaluate,done,"pass: auroc 1, best threshold 0.11"')
    expect(result.stdout).toContain(
      `cutoffs_written: collapse<0.11 keep>=0.70 -> ${userConfigPath(sandbox)}`,
    )
    expect(JSON.parse(readFileSync(userConfigPath(sandbox), 'utf8'))).toEqual({
      cutoffs: {
        collapse_below: 0.11,
        keep_at: 0.7,
        replay: 'public-v1',
        snapshot: SNAPSHOT,
        tested_collapse_below: 0.11,
        written_at: '2026-09-24',
      },
    })
    expect(statSync(userConfigPath(sandbox)).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved).toMatchObject({
      replay: 'public-v1',
      verdict: 'pass',
      question_pack: QUESTION_PACK_VERSION,
      snapshots: [SNAPSHOT],
      items: 10,
      real: 5,
      noise: 5,
      auroc: 1,
      auroc_ci95: [1, 1],
      best_threshold: 0.11,
      noise_collapsed: 1,
      real_hidden: 0,
      keep_precision: 1,
    })
  })

  it('fails when AUROC is below the pre-registered minimum, and writes no cut-offs', async () => {
    const { sandbox, gitHub } = tenPullRequests()

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev: jevScoring(0.4, 0.6) })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('evaluate,done,"fail: auroc 0, best threshold 0.01"')
    expect(result.stdout).not.toContain('cutoffs_written')
    expect(existsSync(userConfigPath(sandbox))).toBe(false)
  })

  it('refuses the pass rule when the items were scored on more than one snapshot', async () => {
    const { sandbox, gitHub } = tenPullRequests()
    const jev = jevScoring(0.9, 0.1, {
      snapshot: (call) => (call <= 5 ? SNAPSHOT : 'typesafe/jev-1.13-20261001'),
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev })

    expect(result.stdout).toContain(
      'evaluate,done,"refused: scored on 2 snapshots; re-score on one before the pass rule applies"',
    )
    expect(existsSync(userConfigPath(sandbox))).toBe(false)
    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved.verdict).toBe('refused')
    expect(saved.by_snapshot.map((row: { snapshot: string }) => row.snapshot)).toEqual([
      SNAPSHOT,
      'typesafe/jev-1.13-20261001',
    ])
  })

  it('keeps the rest of the user config, and prints the hand-set cut-offs it replaces', async () => {
    const { sandbox, gitHub } = tenPullRequests()
    sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({
        provider: 'openrouter',
        allow_private: ['acme/private'],
        cutoffs: { collapse_below: 0.25, keep_at: 0.75 },
      }),
    )

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev: jevScoring(0.9, 0.1) })

    expect(result.stdout).toContain('cutoffs_replaced: collapse<0.25 keep>=0.75 (hand-set)')
    const written = JSON.parse(readFileSync(userConfigPath(sandbox), 'utf8'))
    expect(written.provider).toBe('openrouter')
    expect(written.allow_private).toEqual(['acme/private'])
    expect(written.cutoffs).toMatchObject({ collapse_below: 0.11, keep_at: 0.7 })
  })

  it('raises keep_at to the chosen threshold when the threshold is above 0.70', async () => {
    const { sandbox, gitHub } = tenPullRequests()

    await runReplay(['public-v1'], sandbox, gitHub, { jev: jevScoring(0.95, 0.8) })

    const written = JSON.parse(readFileSync(userConfigPath(sandbox), 'utf8'))
    expect(written.cutoffs).toMatchObject({ collapse_below: 0.81, keep_at: 0.81 })
  })

  it('logs each evaluation with the question pack, snapshot and results', async () => {
    const { sandbox, gitHub } = tenPullRequests()

    await runReplay(['public-v1'], sandbox, gitHub, { jev: jevScoring(0.9, 0.1) })

    expect(readJsonl(replayPath(sandbox, 'runs.jsonl'))).toEqual([
      {
        ts: '2026-09-24T10:00:00.000Z',
        kind: 'evaluate',
        replay: 'public-v1',
        question_pack: QUESTION_PACK_VERSION,
        provider: 'openrouter',
        snapshots: [SNAPSHOT],
        verdict: 'pass',
        items: 10,
        real: 5,
        noise: 5,
        auroc: 1,
        best_threshold: 0.11,
        noise_collapsed: 1,
        real_hidden: 0,
        keep_precision: 1,
      },
    ])
  })

  it('treats a re-run with unchanged scores as a no-op, and refuses evaluate before score', async () => {
    const { sandbox, gitHub } = tenPullRequests()
    const early = await runReplay(['public-v1', '--stage', 'evaluate'], sandbox, gitHub)
    await runReplay(['public-v1'], sandbox, gitHub, { jev: jevScoring(0.9, 0.1) })

    const again = await runReplay(['public-v1', '--stage', 'evaluate'], sandbox, gitHub)

    expect(early.exitCode).toBe(2)
    expect(early.stdout).toContain('--stage score')
    expect(again.exitCode).toBe(0)
    expect(again.stdout).not.toContain('cutoffs_written')
    expect(readJsonl(replayPath(sandbox, 'runs.jsonl'))).toHaveLength(1)
  })
})
