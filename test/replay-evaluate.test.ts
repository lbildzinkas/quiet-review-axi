import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUESTION_PACK_VERSION } from '../src/core/questions.js'
import { createFakeJev, readJsonl, runReplay, setupReplay } from './helpers/replay.js'
import { createFakeLabelModel } from './helpers/fake-label-model.js'
import { sampledReplay } from './helpers/scored-replay.js'
import type { Sandbox } from './helpers/run-cli.js'

const SNAPSHOT = 'typesafe/jev-1.13-20260917'

// Ten merged PRs with one comment each: the odd ones changed the commented lines (real),
// the even ones did not (noise). Each body says which, so the fake Jev can score it, and
// carries its comment id, so the fake label model can answer it.
function tenPullRequests() {
  return setupReplay({
    config: { target_items: 100 },
    specs: [
      {
        name: 'acme/widgets',
        bots: { 'coderabbitai[bot]': 10 },
        body: ({ pr, id }) => `${pr % 2 === 1 ? 'Real' : 'Noise'} comment (#${id}) on part ${pr}`,
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

// Sets the maintainer's `label` on review.jsonl lines, by pull request, as a person would.
function fillReview(sandbox: Sandbox, labels: Record<number, string>) {
  const path = replayPath(sandbox, 'review.jsonl')
  const filled = readJsonl(path).map((line) => ({ ...line, label: labels[Number(line.pr)] }))
  writeFileSync(path, filled.map((line) => `${JSON.stringify(line)}\n`).join(''))
}

// The replay world's comment ids encode their pull request: 1_000_000 + pr * 1000 + ...
function prOf(commentId: number): number {
  return Math.floor((commentId % 1_000_000) / 1000)
}

// The AI calls PR 1 (automatically real) noise and is unsure about PR 2 (automatically noise).
function twoToReview() {
  return createFakeLabelModel({
    answer: (id) =>
      ({ 1: 'noise', 2: 'unsure' })[prOf(id)] ?? (prOf(id) % 2 === 1 ? 'real' : 'noise'),
  })
}

describe('evaluate behind the label-check trust gate', () => {
  it('gives inconclusive instead of a pass when the review overturns too many automatic labels, and writes no cut-offs', async () => {
    const { sandbox, gitHub } = tenPullRequests()
    const jev = jevScoring(0.9, 0.1)
    await runReplay(['public-v1'], sandbox, gitHub, { jev, labelModel: twoToReview() })
    // Overturns 1 of the 2 reviewed labels (0.5); the scores alone would still pass.
    fillReview(sandbox, { 1: 'noise', 2: 'noise' })

    const result = await runReplay(['public-v1'], sandbox, gitHub, { jev })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'evaluate,done,"inconclusive: the review overturned 1 of 2 automatic labels (0.5), more than 0.2"',
    )
    expect(result.stdout).not.toContain('cutoffs_written')
    expect(existsSync(userConfigPath(sandbox))).toBe(false)
    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved).toMatchObject({
      verdict: 'inconclusive',
      trust: 'inconclusive',
      trust_reasons: ['the review overturned 1 of 2 automatic labels (0.5), more than 0.2'],
      calibrated_cutoffs: null,
    })
    expect(readJsonl(replayPath(sandbox, 'runs.jsonl')).map((line) => line.verdict)).toEqual([
      'inconclusive',
    ])
  })

  it('refuses the pass rule while the review of the label check is unfinished', async () => {
    const { sandbox, gitHub } = tenPullRequests()
    const jev = jevScoring(0.9, 0.1)
    await runReplay(['public-v1'], sandbox, gitHub, { jev, labelModel: twoToReview() })

    const result = await runReplay(['public-v1', '--stage', 'evaluate'], sandbox, gitHub, { jev })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'evaluate,done,"refused: 2 label-check items await review; label them in review.jsonl before the pass rule applies"',
    )
    expect(existsSync(userConfigPath(sandbox))).toBe(false)
    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved).toMatchObject({ verdict: 'refused', trust: 'pending review' })
  })
})

describe('evaluate on the label-check sample alone (robustness check)', () => {
  it('computes the same metrics on the sampled items, apart from the full-set verdict', async () => {
    const { sandbox, gitHub, jev } = sampledReplay()

    await runReplay(['public-v1'], sandbox, gitHub, { jev })

    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved).toMatchObject({ verdict: 'pass', items: 10, auroc: 0.96, best_threshold: 0.31 })
    expect(saved.label_check_sample).toEqual({
      items: 4,
      real: 2,
      noise: 2,
      auroc: 1,
      auroc_ci95: [1, 1],
      best_threshold: 0.31,
      noise_collapsed: 1,
      noise_collapsed_ci95: [1, 1],
      real_hidden: 0,
      real_hidden_ci95: [0, 0],
      keep_precision: 1,
      keep_precision_ci95: [1, 1],
    })
  })

  it("uses the check's final labels, so a label the maintainer corrected counts as corrected", async () => {
    const { sandbox, gitHub, jev } = sampledReplay()
    // The AI calls sampled PR 7 (automatically real, worth 0.7) noise, and the maintainer agrees.
    const labelModel = createFakeLabelModel({
      answer: (id) => (prOf(id) === 7 ? 'noise' : prOf(id) % 2 === 1 ? 'real' : 'noise'),
    })
    await runReplay(['public-v1'], sandbox, gitHub, { jev, labelModel })
    fillReview(sandbox, { 7: 'noise' })

    await runReplay(['public-v1'], sandbox, gitHub, { jev })

    // Real PR 9 (0.95) against noise PRs 2, 10 and 7 (0.1, 0.3, 0.7): 0.71 collapses all three,
    // and of the two items at or above 0.70 only PR 9 is real.
    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved.label_check_sample).toMatchObject({
      items: 4,
      real: 1,
      noise: 3,
      auroc: 1,
      best_threshold: 0.71,
      noise_collapsed: 1,
      real_hidden: 0,
      keep_precision: 0.5,
    })
  })

  it('has no sample metrics while the review of the label check is unfinished', async () => {
    const { sandbox, gitHub, jev } = sampledReplay()
    const labelModel = createFakeLabelModel({
      answer: (id) => (prOf(id) === 7 ? 'unsure' : prOf(id) % 2 === 1 ? 'real' : 'noise'),
    })
    await runReplay(['public-v1'], sandbox, gitHub, { jev, labelModel })

    const result = await runReplay(['public-v1', '--stage', 'evaluate'], sandbox, gitHub, { jev })

    expect(result.exitCode).toBe(0)
    const saved = JSON.parse(readFileSync(replayPath(sandbox, 'result.json'), 'utf8'))
    expect(saved.items).toBe(10)
    expect(saved.label_check_sample).toBeNull()
  })
})
