import { describe, expect, it } from 'vitest'
import { createFakeLabelModel } from './helpers/fake-label-model.js'
import { runReplay, setupReplay } from './helpers/replay.js'

// The replay world's comment ids encode their pull request: 1_000_000 + pr * 1000 + ...
function prOf(commentId: number): number {
  return Math.floor((commentId % 1_000_000) / 1000)
}

// By default the world changes the commented lines on odd pull requests, so the automatic
// label is `real` there and `noise` elsewhere.
function automaticLabel(commentId: number): string {
  return prOf(commentId) % 2 === 1 ? 'real' : 'noise'
}

describe('replay label check (spec 10.6)', () => {
  it('asks the label model about the sample and reports its agreement with the automatic labels', async () => {
    const { sandbox, gitHub } = setupReplay()
    const labelModel = createFakeLabelModel({ answer: automaticLabel })

    const result = await runReplay(['public-v1'], sandbox, gitHub, labelModel)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'check,done,"4 sampled, AI agreement 1 (kappa 1), 0 reviewed, 0 automatic labels corrected"',
    )
    expect(labelModel.chatCalls).toHaveLength(4)
  })
})
