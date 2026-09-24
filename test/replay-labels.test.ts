import { describe, expect, it } from 'vitest'
import { labelComment, type Evidence } from '../src/replay/label.js'

// The comment sits on lines 40-42 of the file at `from`; the widened anchor is 38-44.
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    from: 'from-sha',
    to: 'to-sha',
    anchor: { start: 40, end: 42 },
    compare: { merge_base: 'from-sha', files_listed: 1, file: null },
    file_lines: 200,
    resolved: false,
    replies: [],
    ...overrides,
  }
}

function modified(patch: string, deletions = 1) {
  return {
    compare: {
      merge_base: 'from-sha',
      files_listed: 1,
      file: { filename: 'src/a.ts', status: 'modified', patch, additions: 1, deletions },
    },
  }
}

// A one-line modification of old line `line`.
function editAt(line: number) {
  return `@@ -${line},1 +${line},1 @@\n-old ${line}\n+new ${line}`
}

describe('label rule 1: evidence that cannot be mapped is excluded', () => {
  it('excludes a comment whose commits can no longer be fetched', () => {
    expect(labelComment(evidence({ compare: null }))).toMatchObject({
      label: 'excluded',
      reason: 'commit unavailable',
    })
  })

  it('excludes a comment whose commit is no longer an ancestor of the final head', () => {
    const rebased = { merge_base: 'older-sha', files_listed: 0, file: null }

    expect(labelComment(evidence({ compare: rebased }))).toMatchObject({
      label: 'excluded',
      reason: 'history rewritten',
    })
  })

  it('excludes a comment without a line anchor on the new side', () => {
    expect(labelComment(evidence({ anchor: null }))).toMatchObject({
      label: 'excluded',
      reason: 'anchor unmapped',
    })
  })

  it('excludes a comment whose file was deleted or renamed after the comment', () => {
    const file = (status: string) => ({
      compare: {
        merge_base: 'from-sha',
        files_listed: 1,
        file: { filename: 'src/a.ts', status, additions: 0, deletions: 0 },
      },
    })

    expect(labelComment(evidence(file('removed'))).reason).toBe('file deleted')
    expect(labelComment(evidence(file('renamed'))).reason).toBe('file renamed')
  })

  it('excludes a changed file whose diff GitHub did not return', () => {
    const noPatch = {
      merge_base: 'from-sha',
      files_listed: 1,
      file: { filename: 'src/a.ts', status: 'modified', additions: 900, deletions: 5 },
    }

    expect(labelComment(evidence({ compare: noPatch })).reason).toBe('diff unavailable')
  })

  it('excludes a comment whose file may be missing from a truncated comparison', () => {
    const truncated = { merge_base: 'from-sha', files_listed: 300, file: null }

    expect(labelComment(evidence({ compare: truncated })).reason).toBe('diff unavailable')
  })
})

describe('label rule 5: a change at the anchor is real', () => {
  it('counts a modified line inside the commented range', () => {
    expect(labelComment(evidence(modified(editAt(41))))).toMatchObject({
      label: 'real',
      reason: null,
    })
  })

  it('counts a modified line within 2 lines of the range, but not 3', () => {
    expect(labelComment(evidence(modified(editAt(44)))).label).toBe('real')
    expect(labelComment(evidence(modified(editAt(38)))).label).toBe('real')
    expect(labelComment(evidence(modified(editAt(45)))).label).toBe('noise')
    expect(labelComment(evidence(modified(editAt(37)))).label).toBe('noise')
  })

  it('counts lines inserted directly next to the widened range', () => {
    const insertedAfter44 = '@@ -44,0 +45,2 @@\n+if (!value) return\n+log(value)'
    const insertedAfter50 = '@@ -50,0 +51,1 @@\n+log(value)'

    expect(labelComment(evidence(modified(insertedAfter44, 0))).label).toBe('real')
    expect(labelComment(evidence(modified(insertedAfter50, 0))).label).toBe('noise')
  })

  it('reads old-side line numbers across context lines and several hunks', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' a',
      '+inserted early',
      ' b',
      ' c',
      '@@ -30,5 +31,5 @@',
      ' line 30',
      ' line 31',
      ' line 32',
      '-line 33',
      '+line 33 changed',
      ' line 34',
    ].join('\n')

    expect(labelComment(evidence(modified(patch))).label).toBe('noise')
    expect(
      labelComment(evidence({ ...modified(patch), anchor: { start: 35, end: 35 } })).label,
    ).toBe('real')
  })
})

describe('label rule 2: a large rewrite is excluded', () => {
  it('excludes a comment when more than half of the file changed, even at the anchor', () => {
    const rewritten = modified(editAt(41), 101)

    expect(labelComment(evidence({ ...rewritten, file_lines: 200 }))).toMatchObject({
      label: 'excluded',
      reason: 'rewrite',
    })
  })

  it('keeps a comment when exactly half of the file changed', () => {
    expect(labelComment(evidence({ ...modified(editAt(41), 100), file_lines: 200 })).label).toBe(
      'real',
    )
  })

  it('excludes a changed file whose size at the comment could not be read', () => {
    expect(labelComment(evidence({ ...modified(editAt(41)), file_lines: null }))).toMatchObject({
      label: 'excluded',
      reason: 'file unavailable',
    })
  })
})

const human = (body: string) => ({ author: 'alice', is_bot: false, body })

describe('reply patterns', () => {
  it.each([
    'Fixed, thank you',
    'Done.',
    'good catch!',
    'Addressed in the latest push',
    'Updated',
    'Thanks',
    'See 3f9c2a1',
    'https://github.com/acme/widgets/commit/3f9c2a1b7d',
  ])('reads "%s" from a person as agreement', (body) => {
    expect(labelComment(evidence({ replies: [human(body)] })).signals).toMatchObject({
      agree: true,
      disagree: false,
    })
  })

  it.each([
    'This is not an issue here',
    "Won't fix",
    'won’t fix, out of scope',
    'wontfix',
    'Intentional',
    'This is by design',
    'False positive',
    'That claim is incorrect',
    'Not needed',
    'You can ignore this',
  ])('reads "%s" from a person as disagreement', (body) => {
    expect(labelComment(evidence({ replies: [human(body)] })).signals).toMatchObject({
      agree: false,
      disagree: true,
    })
  })

  it('ignores replies from bots and text with neither pattern', () => {
    const replies = [
      { author: 'coderabbitai[bot]', is_bot: true, body: 'Thanks for the fix! Resolved.' },
      human('Could you explain the defaced cache entry?'),
    ]

    expect(labelComment(evidence({ replies })).signals).toMatchObject({
      agree: false,
      disagree: false,
    })
  })
})

describe('label rules 3-7: supporting signals', () => {
  const changedAtAnchor = modified(editAt(41))

  it('excludes conflicting replies (rule 3), even when the lines changed', () => {
    const replies = [human('Thanks'), human('Actually this is intentional')]

    expect(labelComment(evidence({ ...changedAtAnchor, replies }))).toMatchObject({
      label: 'excluded',
      reason: 'conflicting replies',
    })
  })

  it('excludes a change the author disputed (rule 4)', () => {
    const replies = [human('False positive, the refactor was unrelated')]

    expect(labelComment(evidence({ ...changedAtAnchor, replies }))).toMatchObject({
      label: 'excluded',
      reason: 'conflicting signals',
    })
  })

  it('labels a thread fixed elsewhere as real when a person agreed and it was resolved (rule 6)', () => {
    expect(
      labelComment(evidence({ replies: [human('Fixed in the service layer')], resolved: true })),
    ).toMatchObject({ label: 'real', reason: null })
  })

  it('labels everything else as noise (rule 7)', () => {
    expect(labelComment(evidence({ resolved: true })).label).toBe('noise')
    expect(labelComment(evidence({ replies: [human('Thanks')] })).label).toBe('noise')
    expect(labelComment(evidence({ replies: [human('Not needed')], resolved: true })).label).toBe(
      'noise',
    )
    expect(labelComment(evidence()).label).toBe('noise')
  })

  it('records every signal with the label', () => {
    expect(labelComment(evidence({ ...changedAtAnchor, resolved: true })).signals).toEqual({
      changed: true,
      resolved: true,
      agree: false,
      disagree: false,
    })
  })
})
