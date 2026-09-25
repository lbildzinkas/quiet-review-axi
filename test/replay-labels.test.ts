import { describe, expect, it } from 'vitest'
import { labelComment, type Evidence, type Reply } from '../src/replay/label.js'

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

// The comment under test, as the label rules see it (label-rules-v2): which bot wrote it
// and its body, from whose heading commit subjects are matched.
const comment = (overrides: { bot?: string; body?: string } = {}) => ({
  bot: 'greptile-apps[bot]',
  body: '**Custom HTTP client handler**\n\nThis override closes and raises on error responses.',
  ...overrides,
})

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
const botReply = (bot: string, body: string): Reply => ({ author: bot, is_bot: true, body })

describe('label-rules-v2: withdrawals and disagreements override a coincidental change', () => {
  const changedAtAnchor = modified(editAt(41))

  it('labels noise when the reviewing bot withdrew its finding, even though the lines changed', () => {
    const withdrawal = botReply(
      'greptile-apps[bot]',
      'That constraint is valid. I’m withdrawing this finding for this PR.',
    )

    expect(
      labelComment(
        evidence({ ...changedAtAnchor, resolved: true, replies: [withdrawal] }),
        comment(),
      ),
    ).toMatchObject({ label: 'noise', reason: null })
  })

  it('labels noise when the reviewing bot says the finding does not apply', () => {
    const withdrawal = botReply(
      'coderabbitai[bot]',
      'The finding does not apply to the current CLI. I withdraw the finding.',
    )

    expect(
      labelComment(
        evidence({ ...changedAtAnchor, replies: [withdrawal] }),
        comment({ bot: 'coderabbitai[bot]' }),
      ),
    ).toMatchObject({ label: 'noise', reason: null })
  })

  it('ignores a withdrawal reply from a bot other than the reviewing bot', () => {
    const otherBot = botReply('copilot-pull-request-reviewer[bot]', 'I withdraw the finding.')

    expect(
      labelComment(evidence({ ...changedAtAnchor, replies: [otherBot] }), comment()).label,
    ).toBe('real')
  })

  it.each([
    'No code change needed; the premise is wrong.',
    'Verified as not actionable for the current CLI.',
    'Not applicable here, the flag is always set.',
    'That suggestion does not apply to this code path.',
    'This is working as intended.',
  ])('labels noise when a person replied “%s” and the lines changed', (body) => {
    expect(
      labelComment(evidence({ ...changedAtAnchor, replies: [human(body)] }), comment()),
    ).toMatchObject({
      label: 'noise',
      reason: null,
    })
  })

  it('still excludes a thread whose human replies both agree and disagree', () => {
    const replies = [human('Thanks, fixed.'), human('Actually this is intentional')]

    expect(labelComment(evidence({ ...changedAtAnchor, replies }), comment())).toMatchObject({
      label: 'excluded',
      reason: 'conflicting replies',
    })
  })

  it('ignores agent signature footers when reading replies', () => {
    const replies = [
      human(
        'The junction is captured as a symlink, so nothing walks the pointee.\n_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_',
      ),
      human('Written by an agent (Codex, GPT-5).'),
    ]

    expect(labelComment(evidence({ replies, resolved: true }), comment()).signals).toMatchObject({
      agree: false,
      disagree: false,
    })
  })
})

describe('label-rules-v2: a reply from any account that names a later commit agrees', () => {
  const laterCommits = [
    { sha: 'a286106f4f0000000000000000000000000000000', subject: 'fix: treat 403 misses' },
    { sha: 'e78eb1f470000000000000000000000000000000', subject: 'test: pin junction capture' },
  ]

  it('labels real when the author’s coding agent replied “Fixed in <later commit>” and the thread was resolved', () => {
    const reply = botReply(
      'claude[bot]',
      'Fixed in a286106f4f: a 403 or AccessDenied on GetObject is now a miss.',
    )

    expect(
      labelComment(
        evidence({ resolved: true, commits_after: laterCommits, replies: [reply] }),
        comment(),
      ),
    ).toMatchObject({ label: 'real', reason: null })
  })

  it('reads a person reply that names a later commit, in text or a link, as agreement', () => {
    const replies = [
      human('See https://github.com/acme/widgets/commit/e78eb1f47 for the pinning test.'),
    ]

    expect(
      labelComment(evidence({ resolved: true, commits_after: laterCommits, replies }), comment())
        .signals,
    ).toMatchObject({ agree: true })
  })

  it('does not read a commit from before the comment as agreement', () => {
    const replies = [human('Introduced in 3f9c2a1b7d, so this is expected.')]

    expect(
      labelComment(evidence({ resolved: true, commits_after: laterCommits, replies }), comment())
        .signals,
    ).toMatchObject({ agree: false, disagree: false })
  })

  it('keeps a reply that disputes the comment a disagreement, even when it names a later commit', () => {
    const replies = [
      human('No code change needed; I pinned the behaviour with a test in e78eb1f47.'),
    ]

    expect(
      labelComment(
        evidence({ ...modified(editAt(41)), commits_after: laterCommits, replies }),
        comment(),
      ),
    ).toMatchObject({ label: 'noise', reason: null })
  })

  it('keeps a bot withdrawal a withdrawal, even when its reply names a later commit', () => {
    const reply = botReply(
      'greptile-apps[bot]',
      'I withdraw the finding; the change in a286106f4f was unrelated.',
    )

    expect(
      labelComment(
        evidence({ ...modified(editAt(41)), commits_after: laterCommits, replies: [reply] }),
        comment(),
      ),
    ).toMatchObject({ label: 'noise', reason: null })
  })
})

describe('label-rules-v2: who resolved the thread', () => {
  it('labels real when a reviewing bot whose self-resolve means fixed resolved the thread', () => {
    expect(
      labelComment(
        evidence({ resolved: true, resolved_by: 'cursor[bot]' }),
        comment({ bot: 'cursor[bot]' }),
      ),
    ).toMatchObject({ label: 'real', reason: null })
  })

  it('does not trust the self-resolve of a bot whose resolve behaviour is unverified', () => {
    expect(
      labelComment(
        evidence({ resolved: true, resolved_by: 'coderabbitai[bot]' }),
        comment({ bot: 'coderabbitai[bot]' }),
      ).label,
    ).toBe('noise')
  })

  it('does not count a resolve by a person or another bot as a fix by itself', () => {
    expect(
      labelComment(
        evidence({ resolved: true, resolved_by: 'alice' }),
        comment({
          bot: 'cursor[bot]',
        }),
      ).label,
    ).toBe('noise')
    expect(
      labelComment(
        evidence({ resolved: true, resolved_by: 'coderabbitai[bot]' }),
        comment({ bot: 'cursor[bot]' }),
      ).label,
    ).toBe('noise')
  })

  it('labels noise when the reviewing bot resolved its own thread but also withdrew the finding', () => {
    const withdrawal = botReply('cursor[bot]', 'Fixed elsewhere? No — withdrawing this finding.')

    expect(
      labelComment(
        evidence({ resolved: true, resolved_by: 'cursor[bot]', replies: [withdrawal] }),
        comment({ bot: 'cursor[bot]' }),
      ).label,
    ).toBe('noise')
  })
})

describe('label-rules-v2: a later commit whose subject repeats the comment heading', () => {
  it('labels real when the commit subject repeats a distinctive heading term', () => {
    const body =
      '### Replayable test needs Prometheus callback\n\n**Medium Severity**\n\nThis test is marked `replayable` and waits on `litellm_spend_metric_total`, but the config does not enable the `prometheus` callback.'
    const commits_after = [
      {
        sha: '1d9ecfe000000000000000000000000000000000',
        subject:
          "fix(e2e): scrape every replica's /metrics/ and enable prometheus in the replay lane",
      },
    ]

    expect(labelComment(evidence({ commits_after }), comment({ body }))).toMatchObject({
      label: 'real',
      reason: null,
    })
  })

  it('labels real when the commit subject repeats two shorter heading terms across word boundaries', () => {
    const body =
      '### File search treated as native\n\n**Medium Severity**\n\n`BedrockOpenAIResponsesConfig` inherits `supports_native_file_search` as true, so LiteLLM skips file-search emulation.'
    const commits_after = [
      {
        sha: 'e4b816e000000000000000000000000000000000',
        subject: 'fix(bedrock): emulate file_search and collapse custom Responses paths',
      },
    ]

    expect(labelComment(evidence({ commits_after }), comment({ body }))).toMatchObject({
      label: 'real',
      reason: null,
    })
  })

  it('reads the heading from a bot’s bold title line', () => {
    const body =
      '<a href="#"></a> **Custom HTTP client handler**\n\nThis AsyncClient override directly closes and raises on error responses.'
    const commits_after = [
      {
        sha: '9aa1bcc000000000000000000000000000000000',
        subject: 'refactor(http): reuse the custom client handler for retries',
      },
    ]

    expect(labelComment(evidence({ commits_after }), comment({ body })).signals).toMatchObject({
      commit_match: true,
    })
  })

  it('does not match on a single short shared term alone', () => {
    const body = '### Missing keys can raise Unavailable\n\nS3 returns 403 for missing objects.'
    const commits_after = [
      {
        sha: 'a286106f40000000000000000000000000000000',
        subject: 'fix(rust): isolate explicit s3 keys from env tokens and treat 403 misses',
      },
    ]

    expect(labelComment(evidence({ commits_after }), comment({ body })).signals).toMatchObject({
      commit_match: false,
    })
  })

  it('matches nothing when the comment has no heading', () => {
    const body = 'Possible null dereference of `value` when the cache is cold.'
    const commits_after = [
      {
        sha: '9aa1bcc000000000000000000000000000000000',
        subject: 'fix: guard null dereference of value',
      },
    ]

    expect(labelComment(evidence({ commits_after }), comment({ body })).signals).toMatchObject({
      commit_match: false,
    })
  })
})

describe('label-rules-v2: fixes that landed after the merge', () => {
  const followups = [
    { sha: '4ece41f000000000000000000000000000000000', subject: 'fix: correct the昇腾 typo' },
  ]

  it('labels real when a follow-up on the base branch changed the commented lines', () => {
    expect(labelComment(evidence({ followups }), comment())).toMatchObject({
      label: 'real',
      reason: null,
    })
  })
})

describe('label-rules-v2: comments with no commits after them', () => {
  const noCommits = {
    from: 'head-sha',
    to: 'head-sha',
    compare: { merge_base: 'head-sha', files_listed: 1, file: null },
  }

  it('excludes a comment on the final head commit when no other fix evidence exists', () => {
    expect(labelComment(evidence(noCommits), comment())).toMatchObject({
      label: 'excluded',
      reason: 'no commits after comment',
    })
  })

  it('keeps a known outcome: a disagreement stays noise', () => {
    const replies = [human('No code change needed.')]

    expect(labelComment(evidence({ ...noCommits, replies }), comment()).label).toBe('noise')
  })

  it('keeps a comment whose fix landed after the merge', () => {
    const followups = [
      { sha: '4ece41f000000000000000000000000000000000', subject: 'fix: the typo' },
    ]

    expect(labelComment(evidence({ ...noCommits, followups }), comment()).label).toBe('real')
  })

  it('keeps a comment whose thread was resolved by a trusted reviewing bot', () => {
    expect(
      labelComment(
        evidence({ ...noCommits, resolved: true, resolved_by: 'cursor[bot]' }),
        comment({ bot: 'cursor[bot]' }),
      ).label,
    ).toBe('real')
  })

  it('labels noise when the comment predates the final head commit', () => {
    expect(labelComment(evidence(), comment()).label).toBe('noise')
  })
})

describe('reply patterns (label-rules-v2)', () => {
  it.each([
    'Fixed, thank you',
    'Done.',
    'good catch!',
    'Addressed in the latest push',
    'Updated',
    'Thanks',
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
    'No code change needed',
    'Verified as not actionable',
    'Not applicable to this CLI',
    'That does not apply here',
    'Working as intended',
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

describe('label rules: supporting signals', () => {
  const changedAtAnchor = modified(editAt(41))

  it('excludes conflicting replies (rule 3), even when the lines changed', () => {
    const replies = [human('Thanks'), human('Actually this is intentional')]

    expect(labelComment(evidence({ ...changedAtAnchor, replies }), comment())).toMatchObject({
      label: 'excluded',
      reason: 'conflicting replies',
    })
  })

  it('labels a thread fixed elsewhere as real when a person agreed and it was resolved (rule 6)', () => {
    expect(
      labelComment(evidence({ replies: [human('Fixed in the service layer')], resolved: true })),
    ).toMatchObject({ label: 'real', reason: null })
  })

  it('labels everything else as noise', () => {
    expect(labelComment(evidence({ resolved: true })).label).toBe('noise')
    expect(labelComment(evidence({ replies: [human('Thanks')] })).label).toBe('noise')
    expect(labelComment(evidence({ replies: [human('Not needed')], resolved: true })).label).toBe(
      'noise',
    )
    expect(labelComment(evidence()).label).toBe('noise')
  })

  it('records every signal with the label', () => {
    expect(
      labelComment(
        evidence({ ...changedAtAnchor, resolved: true }),
        comment({ bot: 'greptile-apps[bot]' }),
      ).signals,
    ).toEqual({
      changed: true,
      resolved: true,
      agree: false,
      disagree: false,
      withdrawn: false,
      resolved_by_bot: false,
      commit_match: false,
      followup_changed: false,
    })
  })
})
