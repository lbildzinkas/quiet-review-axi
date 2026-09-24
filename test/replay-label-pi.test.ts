import { describe, expect, it } from 'vitest'
import { createFakeLabelModel } from './helpers/fake-label-model.js'
import { createFakePi, PI_MODEL, type FakePiOptions } from './helpers/fake-pi.js'
import { runReplay, setupReplay } from './helpers/replay.js'

// The label check on a subscription (spec 10.6): the Pi coding agent CLI, already signed in to
// the provider, answers each sampled item as a subprocess. Tests put a fake `pi` on PATH.
const PI_CHECK = {
  sample_size: 60,
  backend: 'pi',
  model: PI_MODEL,
  thinking: 'max',
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
