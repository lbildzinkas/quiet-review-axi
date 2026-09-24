import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUESTION_PACK_VERSION } from '../src/core/questions.js'
import { combineHandlers, runCli, type Sandbox } from './helpers/run-cli.js'
import { JEV_KEY, readJsonl, runReplay, type FakeJev } from './helpers/replay.js'
import { jevByPart, scoredReplay, WORTH } from './helpers/scored-replay.js'

const BUILT_IN = JSON.parse(
  readFileSync(new URL('../src/core/question-pack.json', import.meta.url), 'utf8'),
)

// A candidate pack: the built-in wording with a reworded worth-acting-on question.
function writeCandidatePack(sandbox: Sandbox, version = 'v0.2'): string {
  const pack = structuredClone(BUILT_IN)
  pack.version = version
  pack.questions.act.instructions.question =
    'Should the author of the change fix the problem that `comments.{item}.comment` raises in `comments.{item}.code` before merging?'
  sandbox.write('work/packs/candidate.json', JSON.stringify(pack))
  return 'packs/candidate.json'
}

async function evaluatedReplay() {
  const setup = scoredReplay()
  await runReplay(['public-v1'], setup.sandbox, setup.gitHub, { jev: setup.jev })
  return setup
}

function gate(argv: string[], sandbox: Sandbox, jev: FakeJev) {
  return runCli(['gate', ...argv], {
    sandbox,
    env: JEV_KEY,
    fetch: combineHandlers({ matches: () => true, handle: jev.handle }),
  })
}

function replayPath(sandbox: Sandbox, name: string) {
  return join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', name)
}

describe('question-pack regression gate', () => {
  it('accepts a new pack that keeps AUROC and the real-hidden limit at the calibrated threshold', async () => {
    const { sandbox } = await evaluatedReplay()
    const pack = writeCandidatePack(sandbox)
    const candidate = jevByPart(WORTH)

    const result = await gate(['public-v1', '--pack', pack], sandbox, candidate)

    expect(result.exitCode).toBe(0)
    expect(candidate.calls).toHaveLength(10)
    expect(candidate.calls[0]?.body).toContain('Should the author of the change fix the problem')
    expect(result.stdout.split('\n').slice(0, 11)).toEqual([
      'gate: accepted',
      'replay: public-v1',
      'question_pack: v0.2',
      `baseline_pack: ${QUESTION_PACK_VERSION}`,
      'model: typesafe/jev-1.13-20260917',
      'baseline_model: typesafe/jev-1.13-20260917',
      'auroc: 0.96',
      'baseline_auroc: 0.96',
      'auroc_drop: 0',
      'threshold: 0.31',
      'real_hidden: 0',
    ])
    expect(result.stdout).toContain(
      'rule: auroc drops by at most 0.02 and real_hidden at the baseline threshold stays <= 0.05',
    )
  })

  it('rejects a pack whose AUROC drops by more than 0.02', async () => {
    const { sandbox } = await evaluatedReplay()
    // A second real comment now scores below a noise comment: AUROC 23/25 = 0.92.
    const candidate = jevByPart({ ...WORTH, 3: 0.38 })

    const result = await gate(
      ['public-v1', '--pack', writeCandidatePack(sandbox)],
      sandbox,
      candidate,
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('gate: rejected\n')
    expect(result.stdout).toContain('auroc_drop: 0.04\n')
    expect(result.stdout).toContain('reasons[1]: "auroc dropped by 0.04, more than 0.02"')
  })

  it('rejects a pack that hides more than 5% of real issues at the calibrated threshold', async () => {
    const { sandbox } = await evaluatedReplay()
    // Every worth halved: the ranking, so AUROC, is unchanged, but the real comment at 0.35
    // now scores 0.175, below the calibrated threshold 0.31.
    const halved = Object.fromEntries(
      Object.entries(WORTH).map(([part, worth]) => [part, worth / 2]),
    )

    const result = await gate(
      ['public-v1', '--pack', writeCandidatePack(sandbox)],
      sandbox,
      jevByPart(halved),
    )

    expect(result.stdout).toContain('gate: rejected\n')
    expect(result.stdout).toContain('auroc: 0.96\n')
    expect(result.stdout).toContain('real_hidden: 0.2\n')
    expect(result.stdout).toContain(
      'reasons[1]: "real_hidden at the baseline threshold 0.31 is 0.2, above 0.05"',
    )
  })

  it('logs each gate run with the pack version, model snapshot and results', async () => {
    const { sandbox } = await evaluatedReplay()

    await gate(['public-v1', '--pack', writeCandidatePack(sandbox)], sandbox, jevByPart(WORTH))

    expect(readJsonl(replayPath(sandbox, 'runs.jsonl')).at(-1)).toEqual({
      ts: '2026-09-24T10:00:00.000Z',
      kind: 'gate',
      replay: 'public-v1',
      question_pack: 'v0.2',
      baseline_pack: QUESTION_PACK_VERSION,
      provider: 'openrouter',
      snapshots: ['typesafe/jev-1.13-20260917'],
      baseline_snapshots: ['typesafe/jev-1.13-20260917'],
      decision: 'accepted',
      items: 10,
      auroc: 0.96,
      baseline_auroc: 0.96,
      auroc_drop: 0,
      threshold: 0.31,
      real_hidden: 0,
    })
  })

  it("leaves the replay's pre-registered result and the calibrated cut-offs untouched", async () => {
    const { sandbox } = await evaluatedReplay()
    const configPath = join(sandbox.env.XDG_CONFIG_HOME, 'quiet-review-axi', 'config.json')
    const before = [
      readFileSync(replayPath(sandbox, 'result.json'), 'utf8'),
      readFileSync(configPath, 'utf8'),
    ]

    await gate(
      ['public-v1', '--pack', writeCandidatePack(sandbox)],
      sandbox,
      jevByPart({ ...WORTH, 3: 0.38 }),
    )

    expect([
      readFileSync(replayPath(sandbox, 'result.json'), 'utf8'),
      readFileSync(configPath, 'utf8'),
    ]).toEqual(before)
  })

  it('refuses a pack with the baseline version, an invalid pack, and a replay not yet evaluated', async () => {
    const { sandbox } = await evaluatedReplay()
    const jev = jevByPart(WORTH)
    sandbox.write('work/packs/broken.json', JSON.stringify({ version: 'v0.3', questions: {} }))
    const unevaluated = scoredReplay()

    const same = await gate(['public-v1'], sandbox, jev)
    const broken = await gate(['public-v1', '--pack', 'packs/broken.json'], sandbox, jev)
    const early = await gate(['public-v1'], unevaluated.sandbox, jev)

    expect(same.exitCode).toBe(2)
    expect(same.stdout).toContain(
      `question pack ${QUESTION_PACK_VERSION} is the version replay public-v1 was scored with`,
    )
    expect(broken.exitCode).toBe(2)
    expect(broken.stdout).toContain('Invalid question pack packs/broken.json')
    expect(early.exitCode).toBe(2)
    expect(early.stdout).toContain('has not been evaluated')
    expect(jev.calls).toHaveLength(0)
  })

  it('stops at --max-cost with exit 3', async () => {
    const { sandbox } = await evaluatedReplay()
    const jev = jevByPart(WORTH)

    const result = await gate(
      ['public-v1', '--pack', writeCandidatePack(sandbox), '--max-cost', '0'],
      sandbox,
      jev,
    )

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('gate: stopped\n')
    expect(result.stdout).toContain('scored: 0 of 10 items')
    expect(jev.calls).toHaveLength(0)
  })

  it('warns when the candidate was scored on another model snapshot than the baseline', async () => {
    const { sandbox } = await evaluatedReplay()
    const jev = jevByPart(WORTH, { snapshot: 'typesafe/jev-1.13-20261001' })

    const result = await gate(['public-v1', '--pack', writeCandidatePack(sandbox)], sandbox, jev)

    expect(result.stdout).toContain(
      'warning: "the candidate was scored on typesafe/jev-1.13-20261001 and the baseline on typesafe/jev-1.13-20260917, so a model change is mixed with the wording change"',
    )
  })
})

describe('question-pack regression gate baseline', () => {
  it('refuses to gate against a replay whose pass rule was refused, and a pack version that is not a plain token', async () => {
    const { sandbox, gitHub } = scoredReplay()
    const mixed = jevByPart(WORTH, {
      snapshot: (call) => (call <= 5 ? 'typesafe/jev-1.13-20260917' : 'typesafe/jev-1.13-20261001'),
    })
    await runReplay(['public-v1'], sandbox, gitHub, { jev: mixed })
    const jev = jevByPart(WORTH)

    const refused = await gate(['public-v1', '--pack', writeCandidatePack(sandbox)], sandbox, jev)
    const traversal = await gate(
      ['public-v1', '--pack', writeCandidatePack(sandbox, '../../escape')],
      sandbox,
      jev,
    )

    expect(refused.exitCode).toBe(2)
    expect(refused.stdout).toContain('has no single-snapshot AUROC and best threshold to protect')
    expect(traversal.exitCode).toBe(2)
    expect(traversal.stdout).toContain('Invalid question pack packs/candidate.json: version')
    expect(jev.calls).toHaveLength(0)
  })
})
