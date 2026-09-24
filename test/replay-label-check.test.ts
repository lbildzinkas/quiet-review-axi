import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeLabelModel } from './helpers/fake-label-model.js'
import { readJsonl, runReplay, setupReplay } from './helpers/replay.js'

// The replay world's comment ids encode their pull request: 1_000_000 + pr * 1000 + ...
function prOf(commentId: number): number {
  return Math.floor((commentId % 1_000_000) / 1000)
}

// Every one of the 10 pull requests the bot commented on is drawn: 5 real, 5 noise.
const ALL_TEN = { config: { target_items: 10 } }

function reviewFile(sandbox: { cwd: string }) {
  return join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', 'review.jsonl')
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

  it('writes disagreements and unsure answers to review.jsonl with evidence and links, then waits for review', async () => {
    const { sandbox, gitHub } = setupReplay(ALL_TEN)
    const labelModel = createFakeLabelModel({
      answer: (id) => ({ 1: 'noise', 2: 'unsure' })[prOf(id)] ?? automaticLabel(id),
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub, labelModel)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'check,waiting,"10 sampled, AI agreement 0.89 (kappa 0.78), 2 await review"',
    )
    expect(result.stdout).toContain('review.jsonl')
    expect(result.stdout).toContain('--stage check')
    const review = readJsonl(reviewFile(sandbox))
    expect(review.map((line) => [line.automatic_label, line.ai_label, line.label])).toEqual([
      ['real', 'noise', null],
      ['noise', 'unsure', null],
    ])
    expect(review[0]).toMatchObject({
      id: 'acme/widgets#1/r1001000',
      comment_url: 'https://github.com/acme/widgets/pull/1#discussion_r1001000',
      pr_url: 'https://github.com/acme/widgets/pull/1',
      compare_url: 'https://github.com/acme/widgets/compare/f-acme-widgets-1...h-acme-widgets-1',
      path: 'src/coderabbitaibot-0.ts',
      ai_reason: 'The evidence says noise.',
      resolved: false,
      replies: [],
    })
    expect(review[0]?.comment).toContain('Possible null dereference')
    expect(review[0]?.code).toContain('const value = read()')
    expect(review[0]?.changes_after_comment).toContain('-line 10')
  })
})
