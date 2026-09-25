import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeLabelModel } from './helpers/fake-label-model.js'
import {
  createFakePi,
  PI_MODEL,
  PI_VERSION,
  type FakePiOptions,
  type PiScript,
} from './helpers/fake-pi.js'
import { readJsonl, runReplay, setupReplay, TOKEN } from './helpers/replay.js'

// The label check on a subscription (spec 10.6): the Pi coding agent CLI, already signed in to
// the provider, answers each sampled item as a subprocess. Tests put a fake `pi` on PATH.
const PI_CHECK = {
  sample_size: 60,
  backend: 'pi',
  model: PI_MODEL,
  thinking: 'max',
}

function replayPath(sandbox: { cwd: string }, file: string) {
  return join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', file)
}

function setupPiReplay(options: { config?: Record<string, unknown>; pi?: FakePiOptions } = {}) {
  const { sandbox, gitHub } = setupReplay({
    config: { label_check: PI_CHECK, ...options.config },
  })
  const pi = createFakePi(sandbox, options.pi)
  return { sandbox, gitHub, pi }
}

describe('label check through the Pi CLI (spec 10.6)', () => {
  it('labels the sample through pi and makes no OpenRouter label-model call', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay()
    const labelModel = createFakeLabelModel()

    const result = await runReplay(['public-v1'], sandbox, gitHub, { labelModel, env: pi.env })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'check,done,"4 sampled, AI agreement 1 (kappa 1), 0 reviewed, 0 automatic labels corrected"',
    )
    expect(pi.calls()).toHaveLength(4)
    expect(labelModel.chatCalls).toHaveLength(0)
    expect(labelModel.pricingCalls).toHaveLength(0)
    expect(result.stderr).toContain(`check: asking ${PI_MODEL} through pi about 4 sampled comments`)
  })
})

describe('pi invocation (spec 10.6 step 2)', () => {
  it('runs pi in print mode with the pinned model and thinking, no tools or context, and the evidence on stdin', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay()

    await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    const call = pi.calls()[0]
    const flag = (name: string) => call?.args[(call?.args.indexOf(name) ?? -2) + 1]
    expect(call?.args.slice(0, 3)).toEqual(['--print', '--mode', 'json'])
    expect(flag('--model')).toBe(PI_MODEL)
    expect(flag('--thinking')).toBe('max')
    for (const off of ['--no-session', '--no-tools', '--no-context-files', '--no-extensions'])
      expect(call?.args).toContain(off)
    expect(flag('--system-prompt')).toContain('did the author act on this comment')
    expect(call?.args.join('\n')).not.toContain('(#')
    const evidence = JSON.parse(call?.stdin.slice(call.stdin.indexOf('{')) ?? '{}') as object
    expect(Object.keys(evidence)).toEqual([
      'path',
      'lines',
      'comment',
      'code',
      'changes_after_comment',
      'pr_title',
      'pr_description',
      'later_commit_subjects',
      'followup_fixes',
      'resolved',
      'resolved_by',
      'replies',
    ])
    expect(call?.stdin).not.toContain('automatic')
    expect(call?.stdin).not.toContain('coderabbitai[bot]')
    expect(call?.cwd).toBe('/')
  })

  it('runs byte-identical invocations from the same data', async () => {
    const first = setupPiReplay()
    const second = setupPiReplay()

    await runReplay(['public-v1'], first.sandbox, first.gitHub, { env: first.pi.env })
    await runReplay(['public-v1'], second.sandbox, second.gitHub, { env: second.pi.env })

    expect(second.pi.calls()).toEqual(first.pi.calls())
    expect(first.pi.calls()).toHaveLength(4)
  })
})

function callLog(sandbox: { env: { XDG_STATE_HOME: string } }) {
  return readJsonl(join(sandbox.env.XDG_STATE_HOME, 'quiet-review-axi', 'calls.jsonl')).filter(
    (line) => line.prompt === 'label-check-v2',
  )
}

describe('pi calls: log, cost and cache (spec 9.2, 9.3)', () => {
  it('logs each call with the backend, model, snapshot and pi version, at no cost, and never the comment text', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay({ pi: { snapshot: 'glm-5.3-20260901' } })

    const result = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    const lines = callLog(sandbox)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({
      command: 'replay',
      provider: 'pi',
      model: PI_MODEL,
      prompt: 'label-check-v2',
      snapshot: 'glm-5.3-20260901',
      input_tokens: 1000,
      output_tokens: 40,
      cost_usd: 0,
      cost_source: 'subscription',
      cli_version: PI_VERSION,
      cached: false,
      status: 'ok',
    })
    expect(lines[0]?.response_id).toMatch(/^fake-response-/)
    const logText = readFileSync(
      join(sandbox.env.XDG_STATE_HOME, 'quiet-review-axi', 'calls.jsonl'),
      'utf8',
    )
    expect(logText).not.toContain('(#')
    expect(result.stdout).toContain('label_backend: pi')
    expect(result.stdout).toContain(`label_model: ${PI_MODEL}`)
    expect(result.stdout).toContain('label_check_cost_usd: 0')
    const rows = readJsonl(replayPath(sandbox, 'check.jsonl'))
    expect(rows.map((row) => [row.model, row.cost_usd])).toEqual(
      Array(4).fill(['glm-5.3-20260901', 0]),
    )
  })
})

describe('pi calls: cache and budget', () => {
  it('serves a repeated check from the cache: no pi run, a cached log line', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay()
    const first = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })
    rmSync(replayPath(sandbox, 'manifest.json'))

    const again = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    expect(pi.calls()).toHaveLength(4)
    const checkRow = (stdout: string) => stdout.split('\n').find((line) => /check,/.test(line))
    expect(checkRow(again.stdout)).toEqual(checkRow(first.stdout))
    expect(
      callLog(sandbox)
        .slice(4)
        .map((line) => [line.cached, line.cost_usd, line.cost_source, line.cli_version]),
    ).toEqual(Array(4).fill([true, 0, 'subscription', PI_VERSION]))
  })

  it('costs nothing against --max-cost and needs no OpenRouter key', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay()
    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)

    const result = await runReplay(
      ['public-v1', '--stage', 'check', '--max-cost', '0'],
      sandbox,
      gitHub,
      {
        env: { ...pi.env, OPENROUTER_API_KEY: '' },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('check,done,"4 sampled')
    expect(pi.calls()).toHaveLength(4)
  })
})

// Every one of the 10 pull requests the bot commented on is drawn: 5 real, 5 noise.
const ALL_TEN = { target_items: 10 }

// The same script for every pull request of the replay world, whichever are sampled.
function everyPr(script: PiScript): Record<number, PiScript> {
  return Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, script]))
}

describe('pi answers and failures', () => {
  it('sends an unreadable answer to review as unsure', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay({
      config: ALL_TEN,
      pi: { byPr: { 1: 'I would say this one is fine.' } },
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('1 await review')
    expect(result.stdout).toContain('could not be read')
    const review = readJsonl(replayPath(sandbox, 'review.jsonl'))
    expect(review.map((line) => [line.pr, line.ai_label])).toEqual([[1, 'unsure']])
  })

  it('stops with a clear error when pi exits non-zero, logs it redacted, and a re-run asks only about the rest', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay({
      config: ALL_TEN,
      pi: {
        byPr: { 3: { exit: 1, stderr: `Rate limit reached for ${TOKEN.GITHUB_TOKEN}\nmore` } },
      },
    })

    const failed = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })
    const asked = pi.calls().length
    pi.rescript({})
    const resumed = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    expect(failed.exitCode).toBe(4)
    expect(failed.stdout).toContain('code: PROVIDER_ERROR')
    expect(failed.stdout).toContain('pi exited with code 1: Rate limit reached for')
    expect(failed.stdout).not.toContain(TOKEN.GITHUB_TOKEN)
    const errorLine = callLog(sandbox).find((line) => line.status === 'error')
    expect(errorLine).toMatchObject({ provider: 'pi', error_code: 'PROVIDER_ERROR', cost_usd: 0 })
    expect(String(errorLine?.error_body)).toContain('Rate limit reached')
    for (const file of sandbox.writtenFiles())
      expect(file.content, file.path).not.toContain(TOKEN.GITHUB_TOKEN)
    expect(resumed.exitCode).toBe(0)
    expect(resumed.stdout).toContain('check,done,"10 sampled')
    expect(pi.calls().length - asked).toBe(10 - (asked - 1))
  })

  it('stops with a clear error when the model call through pi fails, and does not cache it', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay({
      pi: { byPr: everyPr({ stopReason: 'error', errorMessage: '429 Usage limit reached' }) },
    })

    const first = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })
    const again = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    expect(first.exitCode).toBe(4)
    expect(first.stdout).toContain('code: PROVIDER_ERROR')
    expect(first.stdout).toContain(
      'The label model call through pi failed: 429 Usage limit reached',
    )
    expect(again.exitCode).toBe(4)
    expect(pi.calls()).toHaveLength(2)
  })

  it('refuses output that holds no answer from the model', async () => {
    const { sandbox, gitHub, pi } = setupPiReplay({ pi: { byPr: everyPr({ noAnswer: true }) } })

    const result = await runReplay(['public-v1'], sandbox, gitHub, { env: pi.env })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: INVALID_RESPONSE')
    expect(result.stdout).toContain('no answer through pi')
  })

  it('says pi is missing when it is not on PATH', async () => {
    const { sandbox, gitHub } = setupPiReplay()

    const result = await runReplay(['public-v1'], sandbox, gitHub, {
      env: { PATH: join(sandbox.root, 'empty-bin') },
    })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('no `pi` on PATH')
    expect(result.stdout).toContain('Install the Pi coding agent CLI')
  })
})

describe('check stage guidance with pi', () => {
  it('points to the check stage without an OpenRouter key or a paid budget', async () => {
    const { sandbox, gitHub } = setupPiReplay()
    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)

    const labelled = await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)

    expect(labelled.stdout).toContain(
      `--stage check\` to check a sample of the labels with ${PI_MODEL} through pi (subscription, no per-call cost)`,
    )
    expect(labelled.stdout).not.toContain('OPENROUTER_API_KEY')
  })
})
