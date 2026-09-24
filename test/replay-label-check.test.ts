import { readFileSync, writeFileSync } from 'node:fs'
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

function replayPath(sandbox: { cwd: string }, file: string) {
  return join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', file)
}

// Sets the maintainer's `label` on review.jsonl lines, by pull request, as a person would.
function fillReview(sandbox: { cwd: string }, labels: Record<number, string>) {
  const path = replayPath(sandbox, 'review.jsonl')
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const filled = lines.map((text) => {
    const line = JSON.parse(text) as { pr: number; label: string | null }
    return JSON.stringify({ ...line, label: labels[line.pr] ?? line.label })
  })
  writeFileSync(path, `${filled.join('\n')}\n`)
}

// PR 1 (automatic real) is labelled noise by the AI, PR 2 (automatic noise) unsure.
const TWO_TO_REVIEW = (id: number) => ({ 1: 'noise', 2: 'unsure' })[prOf(id)] ?? automaticLabel(id)

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
    const labelModel = createFakeLabelModel({ answer: TWO_TO_REVIEW })

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

  it('reads the maintainer labels back from review.jsonl and combines them with the agreed labels', async () => {
    const { sandbox, gitHub } = setupReplay(ALL_TEN)
    await runReplay(['public-v1'], sandbox, gitHub, createFakeLabelModel({ answer: TWO_TO_REVIEW }))
    fillReview(sandbox, { 1: 'noise' })
    const partly = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)
    fillReview(sandbox, { 2: 'noise' })

    const reviewed = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    expect(partly.stdout).toContain(
      'check,waiting,"10 sampled, AI agreement 0.89 (kappa 0.78), 1 await review"',
    )
    expect(reviewed.exitCode).toBe(0)
    expect(reviewed.stdout).toContain(
      'check,done,"10 sampled, AI agreement 0.89 (kappa 0.78), 2 reviewed, 1 automatic label corrected"',
    )
    expect(reviewed.fetchCalls).toHaveLength(0)
    const final = readJsonl(replayPath(sandbox, 'final-labels.jsonl'))
    expect(final).toHaveLength(10)
    expect(final.slice(0, 4)).toEqual([
      { id: 'acme/widgets#1/r1001000', label: 'noise', source: 'maintainer' },
      { id: 'acme/widgets#10/r1010000', label: 'noise', source: 'agreed' },
      { id: 'acme/widgets#2/r1002000', label: 'noise', source: 'maintainer' },
      { id: 'acme/widgets#3/r1003000', label: 'real', source: 'agreed' },
    ])
  })

  it('refuses a review label other than real, noise or excluded, naming the line', async () => {
    const { sandbox, gitHub } = setupReplay(ALL_TEN)
    await runReplay(['public-v1'], sandbox, gitHub, createFakeLabelModel({ answer: TWO_TO_REVIEW }))
    fillReview(sandbox, { 2: 'maybe' })

    const result = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain(
      'review.jsonl line 2: label must be real, noise, excluded or null, not \\"maybe\\"',
    )
  })

  it('refuses a review file that lost the line of an item awaiting review', async () => {
    const { sandbox, gitHub } = setupReplay(ALL_TEN)
    await runReplay(['public-v1'], sandbox, gitHub, createFakeLabelModel({ answer: TWO_TO_REVIEW }))
    const path = replayPath(sandbox, 'review.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8').split('\n')[0] + '\n')

    const result = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('review.jsonl has no line for acme/widgets#2/r1002000')
  })

  it('updates the final labels when the maintainer changes a label after the review was complete', async () => {
    const { sandbox, gitHub } = setupReplay(ALL_TEN)
    await runReplay(['public-v1'], sandbox, gitHub, createFakeLabelModel({ answer: TWO_TO_REVIEW }))
    fillReview(sandbox, { 1: 'real', 2: 'noise' })
    await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)
    fillReview(sandbox, { 1: 'excluded' })

    const result = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    expect(result.stdout).toContain('2 reviewed, 1 automatic label corrected')
    expect(readJsonl(replayPath(sandbox, 'final-labels.jsonl'))[0]).toEqual({
      id: 'acme/widgets#1/r1001000',
      label: 'excluded',
      source: 'maintainer',
    })
  })
})
