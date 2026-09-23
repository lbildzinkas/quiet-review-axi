import { describe, expect, it } from 'vitest'
import type { Item } from '../src/core/items.js'
import { buildRequests, estimateTokens } from '../src/core/state.js'

function item(n: number, overrides: Partial<Item> = {}): Item {
  return {
    key: `c${n}`,
    id: `c${n}`,
    body: `Comment ${n}`,
    code: `@@ -1,1 +1,1 @@\n+line ${n}`,
    context: 'hunk',
    path: 'src/a.ts',
    line: n,
    lines: String(n),
    author: 'bot[bot]',
    url: null,
    ...overrides,
  }
}

const HEADER = { repository: 'acme/widgets', title: 'Add retry to webhook sender' }

describe('request builder', () => {
  it('builds the spec state and the four-question set for one item', () => {
    const requests = buildRequests({
      header: HEADER,
      items: [
        item(1, {
          path: 'src/webhook.ts',
          lines: '86-88',
          code: '@@ -80,9 +80,14 @@\n+  for (;;) {\n+    attempt++',
          body: 'Retry loop never resets `attempt`.',
        }),
      ],
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.state).toEqual({
      pr: { repository: 'acme/widgets', title: 'Add retry to webhook sender' },
      comments: {
        c1: {
          path: 'src/webhook.ts',
          lines: '86-88',
          code: '@@ -80,9 +80,14 @@\n+  for (;;) {\n+    attempt++',
          comment: 'Retry loop never resets `attempt`.',
        },
      },
    })
    expect(requests[0]?.questions).toEqual({
      c1_act: {
        type: 'noul',
        instructions: {
          review_comment: '`comments.c1.comment`',
          code_under_review: '`comments.c1.code`',
          question:
            'Does `comments.c1.comment` point out a concrete problem in `comments.c1.code` that the author of the change should fix before merging?',
        },
        criteria: {
          true: 'The comment names a specific defect, risk or mistake that is visible in or directly implied by the shown code, and changing the code as the comment asks would fix a real problem.',
          false:
            'The comment summarizes, praises or restates the change; asks a question without claiming a problem; gives generic advice that is not tied to the shown code; states a matter of taste with no concrete harm; or makes a claim that the shown code does not support.',
        },
      },
      c1_cat: {
        type: 'choice',
        instructions:
          'What kind of comment is the review comment `comments.c1.comment` about `comments.c1.code`?',
        criteria: {
          bug: {
            what: 'Incorrect behaviour: a logic error, crash, wrong result, missing error handling, race or broken edge case',
            not_for: 'Speed or security problems, which have their own options',
          },
          security: {
            what: 'A vulnerability or unsafe handling of secrets, input, authentication or permissions',
          },
          performance: { what: 'Unnecessary work, slow queries, excess memory or network use' },
          style: {
            what: 'Naming, structure, readability or idiom, with behaviour unchanged',
            not_for: 'One-character or whitespace fixes, which are nits',
          },
          docs: { what: 'Comments, docstrings, README, changelog or other documentation' },
          nit: {
            what: 'A trivial fix such as a typo, whitespace, import order or an unused variable',
          },
          wrong: {
            what: "The comment's claim is incorrect: the problem it describes is not present in the shown code",
          },
          test_gap: { what: 'Missing, weak or broken tests for the changed code' },
          question: { what: 'Asks the author something without claiming a problem' },
          summary_or_praise: {
            what: 'Summarizes, describes or praises the change without raising a problem',
          },
          other: { what: 'None of the other options fits' },
        },
      },
      c1_sev: {
        type: 'score',
        instructions:
          'If the problem that the review comment `comments.c1.comment` describes is real, how serious would it be once `comments.c1.code` is merged?',
        criteria: [
          'The comment describes no problem: it is a summary, praise, a question or a restatement of the change',
          'Cosmetic: naming, formatting, wording or taste; the program behaves exactly the same',
          'Minor: readability, maintainability, a small missing check or a documentation gap that is unlikely to affect users',
          'Moderate: wrong behaviour in some cases, noticeably slower code, or changed logic left without tests',
          'Severe: a likely crash, data loss, security hole or broken core feature',
        ],
      },
    })
  })

  it('asks later items whether they duplicate an earlier item, and never asks the first', () => {
    const [request] = buildRequests({ header: HEADER, items: [item(1), item(2), item(3)] })

    expect(request?.questions.c1_dup).toBeUndefined()
    expect(request?.questions.c3_dup).toEqual({
      type: 'choice',
      instructions:
        'Does the review comment `comments.c3.comment` raise the same problem as one of the earlier comments listed as options? Pick that comment, or `none`.',
      criteria: {
        c1: '`comments.c1.comment`',
        c2: '`comments.c2.comment`',
        none: 'No earlier comment raises the same problem; a related comment about a different problem is not a duplicate',
      },
    })
  })

  it('offers every earlier item on the same file plus the ten nearest earlier items elsewhere', () => {
    const items = [
      item(1, { path: 'src/target.ts' }),
      ...Array.from({ length: 12 }, (_, index) => item(index + 2, { path: 'src/other.ts' })),
      item(14, { path: 'src/target.ts' }),
    ]

    const [request] = buildRequests({ header: HEADER, items })

    const options = Object.keys(request?.questions.c14_dup?.criteria as object)
    expect(options).toEqual([
      'c1',
      'c4',
      'c5',
      'c6',
      'c7',
      'c8',
      'c9',
      'c10',
      'c11',
      'c12',
      'c13',
      'none',
    ])
  })

  describe('splitting a pull request that is too big for one request', () => {
    // About 10,000 estimated tokens each, so two fit in one request and three do not.
    const bigBody = (n: number) => `${n} `.padEnd(35_000, 'x')

    it('estimates tokens as characters divided by 3.5, rounded up', () => {
      expect(estimateTokens('x'.repeat(7))).toBe(2)
      expect(estimateTokens('x'.repeat(8))).toBe(3)
    })

    it('packs whole file groups first-fit in path order into the fewest requests', () => {
      const items = [
        item(1, { path: 'src/b.ts', body: bigBody(1) }),
        item(2, { path: 'src/a.ts', body: bigBody(2) }),
        item(3, { path: 'src/c.ts', body: bigBody(3) }),
        item(4, { path: 'src/b.ts', body: bigBody(4) }),
      ]

      const requests = buildRequests({ header: HEADER, items })

      expect(requests.map((request) => request.itemKeys)).toEqual([
        ['c2', 'c3'],
        ['c1', 'c4'],
      ])
      for (const request of requests) expect(request.state.pr).toEqual(HEADER)
    })

    it('splits one file by line order only when that file alone is over budget', () => {
      const items = [
        item(1, { path: 'src/a.ts', line: 30, body: bigBody(1) }),
        item(2, { path: 'src/a.ts', line: 10, body: bigBody(2) }),
        item(3, { path: 'src/a.ts', line: 20, body: bigBody(3) }),
      ]

      const requests = buildRequests({ header: HEADER, items })

      expect(requests.map((request) => request.itemKeys)).toEqual([['c2', 'c3'], ['c1']])
    })

    it('limits duplicate options to items in the same request', () => {
      const items = [
        item(1, { path: 'src/b.ts', body: bigBody(1) }),
        item(2, { path: 'src/a.ts', body: bigBody(2) }),
        item(3, { path: 'src/c.ts', body: bigBody(3) }),
        item(4, { path: 'src/b.ts', body: bigBody(4) }),
      ]

      const [first, second] = buildRequests({ header: HEADER, items })

      expect(Object.keys(first?.questions.c3_dup?.criteria as object)).toEqual(['c2', 'none'])
      expect(Object.keys(second?.questions.c4_dup?.criteria as object)).toEqual(['c1', 'none'])
    })
  })
})
