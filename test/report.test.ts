import { describe, expect, it } from 'vitest'
import { QUESTION_PACK_VERSION } from '../src/core/questions.js'
import { config } from './fixtures/github/replay-world.js'
import { createFakeLabelModel } from './helpers/fake-label-model.js'
import { createFakeJev, runCli, runReplay, setupReplay } from './helpers/replay.js'
import { sampledReplay, scoredReplay } from './helpers/scored-replay.js'
import type { Sandbox } from './helpers/run-cli.js'

function report(argv: string[], sandbox: Sandbox) {
  return runCli(['report', ...argv], { sandbox })
}

describe('report', () => {
  it('prints the accuracy summary with 95% ranges, and calls nothing', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, { jev })

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
    expect(result.stdout).toContain(
      'label_check: "10 sampled, AI agreement 1 (kappa 1), 0 reviewed, 0 automatic labels corrected"',
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
    await runReplay(['public-v1'], sandbox, gitHub, { jev })

    const first = await report(['public-v1'], sandbox)
    const second = await report(['public-v1'], sandbox)

    expect(second.stdout).toBe(first.stdout)
  })

  it('adds the sweep and the breakdown tables with --json', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, { jev })

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
    await runReplay(['public-v1'], older.sandbox, older.gitHub, {
      jev: older.jev,
      now: new Date('2026-09-20T10:00:00Z'),
    })
    older.sandbox.write(
      'work/replay/public-v2.config.json',
      JSON.stringify(config({ name: 'public-v2', target_items: 100 })),
    )
    await runReplay(['public-v2'], older.sandbox, older.gitHub, {
      jev: older.jev,
      now: new Date('2026-09-22T10:00:00Z'),
    })

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
    await runReplay(['public-v1'], sandbox, gitHub, { jev })

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

describe('report behind the label-check trust gate', () => {
  it('shows an inconclusive verdict with the reasons the automatic labels are not trusted', async () => {
    const { sandbox, gitHub, jev } = sampledReplay()
    const labelModel = createFakeLabelModel({ answer: () => 'unsure' })
    await runReplay(['public-v1'], sandbox, gitHub, { jev, labelModel })
    await runReplay(['public-v1', '--stage', 'evaluate'], sandbox, gitHub, { jev })

    const result = await report(['public-v1'], sandbox)
    const json = JSON.parse((await report(['public-v1', '--json'], sandbox)).stdout)

    const reason =
      'no sampled item got a real or noise label from the AI, so agreement cannot be measured'
    expect(result.stdout.split('\n').slice(0, 3)).toEqual([
      'replay: public-v1',
      'verdict: inconclusive',
      `trust_reasons[1]: "${reason}"`,
    ])
    expect(json).toMatchObject({ verdict: 'inconclusive', trust_reasons: [reason] })
  })
})

describe('report on the label-check sample alone', () => {
  it('shows the sample metrics as a robustness check next to the verdict on every item', async () => {
    const { sandbox, gitHub, jev } = sampledReplay()
    await runReplay(['public-v1'], sandbox, gitHub, { jev })

    const result = await report(['public-v1'], sandbox)
    const json = JSON.parse((await report(['public-v1', '--json'], sandbox)).stdout)

    expect(result.stdout).toContain('verdict: pass\n')
    expect(result.stdout).toContain('auroc: 0.96\n')
    expect(result.stdout).toContain(
      [
        'label_check_sample:',
        '  note: robustness check on the label-check sample alone; the verdict is judged on every item',
        '  items: 4',
        '  real: 2',
        '  noise: 2',
        '  auroc: 1',
        '  auroc_ci95: 1-1',
        '  best_threshold: 0.31',
        '  noise_collapsed: 1',
        '  noise_collapsed_ci95: 1-1',
        '  real_hidden: 0',
        '  real_hidden_ci95: 0-0',
        '  keep_precision: 1',
        '  keep_precision_ci95: 1-1',
      ].join('\n'),
    )
    expect(json.label_check_sample).toMatchObject({ items: 4, auroc: 1, auroc_ci95: '1-1' })
  })

  it('says why there are no sample metrics when the review was unfinished at evaluate', async () => {
    const { sandbox, gitHub, jev } = sampledReplay()
    const labelModel = createFakeLabelModel({ answer: () => 'unsure' })
    await runReplay(['public-v1'], sandbox, gitHub, { jev, labelModel })
    await runReplay(['public-v1', '--stage', 'evaluate'], sandbox, gitHub, { jev })

    const result = await report(['public-v1'], sandbox)

    expect(result.stdout).toContain(
      'label_check_sample: n/a until the label check review is complete\n',
    )
  })
})

describe('home view', () => {
  it('shows the most recently evaluated replay and points to report', async () => {
    const { sandbox, gitHub, jev } = scoredReplay()
    await runReplay(['public-v1'], sandbox, gitHub, { jev })

    const result = await runCli([], { sandbox })

    expect(result.stdout).toContain('last_replay: public-v1 pass auroc=0.96')
    expect(result.stdout).toContain('Run `quiet-review-axi report` to see the latest replay result')
  })
})
