import { describe, expect, it } from 'vitest'
import { QUESTION_PACK_VERSION } from '../src/core/questions.js'
import { config } from './fixtures/github/replay-world.js'
import { createFakeJev, runCli, runReplay, setupReplay } from './helpers/replay.js'
import type { Sandbox } from './helpers/run-cli.js'

// Worth per pull request: odd PRs are real, even ones noise. One real comment (PR 5, 0.35)
// scores below one noise comment (PR 6, 0.4): AUROC 24/25 = 0.96, and the best threshold
// that hides no real comment is 0.31, which collapses 4 of 5 noise comments.
const WORTH: Record<number, number> = {
  1: 0.9,
  2: 0.1,
  3: 0.8,
  4: 0.2,
  5: 0.35,
  6: 0.4,
  7: 0.7,
  8: 0.05,
  9: 0.95,
  10: 0.3,
}

function scoredReplay(name = 'public-v1') {
  const setup = setupReplay({
    config: { name, target_items: 100 },
    specs: [
      {
        name: 'acme/widgets',
        bots: { 'coderabbitai[bot]': 10 },
        body: ({ pr }) => `Comment on part ${pr}`,
      },
    ],
  })
  const jev = createFakeJev({
    byComment: (comment) => ({ act: WORTH[Number(comment.split(' ').at(-1))] ?? 0.5 }),
  })
  return { ...setup, jev }
}

function report(argv: string[], sandbox: Sandbox) {
  return runCli(['report', ...argv], { sandbox })
}

describe('report', () => {
  it('prints the accuracy summary with 95% ranges, and calls nothing', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, jev)

    const result = await report(['public-v1'], sandbox)

    expect(result.exitCode).toBe(0)
    expect(result.fetchCalls).toHaveLength(0)
    const lines = result.stdout.split('\n')
    expect(lines.slice(0, 8)).toEqual([
      'replay: public-v1',
      'verdict: pass',
      'model: typesafe/jev-1.13-20260917',
      `question_pack: ${QUESTION_PACK_VERSION}`,
      'items: 10',
      'real: 5',
      'noise: 5',
      'auroc: 0.96',
    ])
    expect(result.stdout).toMatch(/\nauroc_ci95: 0\.\d+-1\n/)
    expect(result.stdout).toContain('\nbest_threshold: 0.31\nnoise_collapsed: 0.8\n')
    expect(result.stdout).toMatch(/\nnoise_collapsed_ci95: 0\.\d+-1\n/)
    expect(result.stdout).toContain('\nreal_hidden: 0\nreal_hidden_ci95: 0-0\n')
    expect(result.stdout).toContain('\nkeep_precision: 1\nkeep_precision_ci95: 1-1\n')
    expect(result.stdout).toContain(
      'pass_rule: "auroc >= 0.75 and exists t: noise_collapsed >= 0.40 and real_hidden <= 0.05 (judged on measured values)"',
    )
    expect(result.stdout).toContain(
      'note: "best_threshold is chosen on the same data it is measured on, so noise_collapsed and real_hidden are optimistic"',
    )
    expect(result.stdout).toMatch(
      /\ncutoffs_written: collapse<0\.31 keep>=0\.70 -> \S+config\.json\n/,
    )
    expect(result.stdout).toContain(
      'by_bot[1]{bot,items,real,auroc}:\n  "coderabbitai[bot]",10,5,0.96',
    )
    expect(result.stdout).toContain('Run `quiet-review-axi report public-v1 --json`')
  })

  it('gives byte-identical output on every run', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, jev)

    const first = await report(['public-v1'], sandbox)
    const second = await report(['public-v1'], sandbox)

    expect(second.stdout).toBe(first.stdout)
  })

  it('adds the sweep and the breakdown tables with --json', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, jev)

    const result = await report(['public-v1', '--json'], sandbox)

    const document = JSON.parse(result.stdout)
    expect(document.verdict).toBe('pass')
    expect(document.auroc_ci95).toMatch(/^0\.\d+-1$/)
    expect(document.sweep).toHaveLength(99)
    expect(document.sweep[30]).toEqual({ threshold: 0.31, noise_collapsed: 0.8, real_hidden: 0 })
    expect(document.by_repository).toEqual([
      { repository: 'acme/widgets', items: 10, real: 5, noise: 5, real_rate: 0.5, auroc: 0.96 },
    ])
    expect(document.calibration).toHaveLength(10)
    expect(document.calibration[3]).toMatchObject({ from: 0.3, to: 0.4, items: 2, real_rate: 0.5 })
    expect(document.calibration[3].mean_worth).toBeCloseTo(0.325, 12)
    expect(document.by_category).toEqual([
      { category: 'other', items: 10, real: 5, noise: 5, real_rate: 0.5, auroc: 0.96 },
    ])
    expect(document.by_severity[0]).toMatchObject({ severity: 'cosmetic', items: 10 })
    expect(document.snapshots).toEqual(['typesafe/jev-1.13-20260917'])
    expect(document.excluded_by_reason).toEqual({})
    expect(document.duplicate_rate).toBe(0)
  })

  it('reports the most recently evaluated replay when no name is given', async () => {
    const older = scoredReplay('public-v1')
    await runReplay(
      ['public-v1'],
      older.sandbox,
      older.gitHub,
      older.jev,
      new Date('2026-09-20T10:00:00Z'),
    )
    older.sandbox.write(
      'work/replay/public-v2.config.json',
      JSON.stringify(config({ name: 'public-v2', target_items: 100 })),
    )
    await runReplay(
      ['public-v2'],
      older.sandbox,
      older.gitHub,
      older.jev,
      new Date('2026-09-22T10:00:00Z'),
    )

    const result = await report([], older.sandbox)

    expect(result.stdout.split('\n')[0]).toBe('replay: public-v2')
  })

  it('says how to produce a result when no replay has been evaluated', async () => {
    const result = await report([], setupReplay().sandbox)
    const named = await report(['public-v1'], setupReplay().sandbox)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('No evaluated replay')
    expect(result.stdout).toContain('Run `quiet-review-axi replay')
    expect(named.exitCode).toBe(2)
    expect(named.stdout).toContain('Replay public-v1 has not been evaluated')
  })

  it('shows the refusal and each snapshot when the pass rule was refused', async () => {
    const { sandbox, gitHub } = scoredReplay()
    const jev = createFakeJev({
      snapshot: (call) => (call <= 5 ? 'typesafe/jev-1.13-20260917' : 'typesafe/jev-1.13-20261001'),
    })
    await runReplay(['public-v1'], sandbox, gitHub, jev)

    const result = await report(['public-v1'], sandbox)

    expect(result.stdout).toContain('verdict: refused\n')
    expect(result.stdout).toContain(
      'refusal: scored on 2 snapshots; re-score on one before the pass rule applies',
    )
    expect(result.stdout).toContain(
      'model: "typesafe/jev-1.13-20260917, typesafe/jev-1.13-20261001"',
    )
    expect(result.stdout).toContain('by_snapshot[2]{snapshot,items,real,auroc}:')
  })
})

describe('home view', () => {
  it('shows the most recently evaluated replay and points to report', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, jev)

    const result = await runCli([], { sandbox })

    expect(result.stdout).toContain('last_replay: public-v1 pass auroc=0.96')
    expect(result.stdout).toContain('Run `quiet-review-axi report` to see the latest replay result')
  })
})
