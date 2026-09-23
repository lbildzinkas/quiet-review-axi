import { describe, expect, it } from 'vitest'
import { describeCutoffs, resolveCutoffs, type CutoffInputs } from '../src/core/cutoffs.js'
import type { Item } from '../src/core/items.js'
import { decideItems } from '../src/core/verdict.js'
import type { Answer } from '../src/jev/schema.js'

const SNAPSHOT = 'typesafe/jev-1.13-20260917'
const BUILT_IN = resolveCutoffs({})

function item(n: number, body = `Comment ${n}`): Item {
  return {
    key: `c${n}`,
    id: `c${n}`,
    body,
    code: '',
    context: 'hunk',
    path: 'src/a.ts',
    line: n,
    lines: String(n),
    author: null,
    url: null,
  }
}

function answers(
  n: number,
  act: number,
  extra: Record<string, Answer> = {},
): Record<string, Answer> {
  return {
    [`c${n}_act`]: { type: 'noul', noul: act },
    [`c${n}_cat`]: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9, other: 0.1 } },
    [`c${n}_sev`]: { type: 'score', score: 3 },
    ...extra,
  }
}

function decideOne(act: number, cutoffs = BUILT_IN) {
  return decideItems({ items: [item(1)], calls: [['c1']], answers: answers(1, act), cutoffs })[0]
}

describe('verdicts', () => {
  it('keeps at or above keep_at, marks unsure in the band, and collapses below collapse_below', () => {
    expect(decideOne(0.7)?.verdict).toBe('keep')
    expect(decideOne(0.69)?.verdict).toBe('unsure')
    expect(decideOne(0.3)?.verdict).toBe('unsure')
    expect(decideOne(0.29)?.verdict).toBe('collapse')
  })

  it('never lets category, severity or duplication change the verdict', () => {
    const [, duplicate] = decideItems({
      items: [item(1), item(2)],
      calls: [['c1', 'c2']],
      answers: {
        ...answers(1, 0.9),
        ...answers(2, 0.95, {
          c2_cat: {
            type: 'choice',
            choice: 'summary_or_praise',
            probabilities: { summary_or_praise: 1 },
          },
          c2_sev: { type: 'score', score: 0 },
          c2_dup: { type: 'choice', choice: 'c1', probabilities: { c1: 0.9, none: 0.1 } },
        }),
      },
      cutoffs: BUILT_IN,
    })

    expect(duplicate).toMatchObject({
      verdict: 'keep',
      dupOf: 'c1',
      category: 'summary_or_praise',
      severity: 0,
    })
  })

  it('marks the category uncertain below 0.60 top probability, or without probabilities', () => {
    const decide = (cat: Answer) =>
      decideItems({
        items: [item(1)],
        calls: [['c1']],
        answers: { ...answers(1, 0.5), c1_cat: cat },
        cutoffs: BUILT_IN,
      })[0]

    expect(
      decide({ type: 'choice', choice: 'style', probabilities: { style: 0.59, nit: 0.41 } }),
    ).toMatchObject({
      category: 'style',
      isCategoryConfident: false,
    })
    expect(
      decide({ type: 'choice', choice: 'style', probabilities: { style: 0.6, nit: 0.4 } })
        ?.isCategoryConfident,
    ).toBe(true)
    expect(decide({ type: 'choice', choice: 'style' })?.isCategoryConfident).toBe(false)
  })

  describe('duplicates', () => {
    function decideDuplicate(dup: Answer) {
      return decideItems({
        items: [item(1), item(2)],
        calls: [['c1', 'c2']],
        answers: { ...answers(1, 0.9), ...answers(2, 0.9, { c2_dup: dup }) },
        cutoffs: BUILT_IN,
      })[1]?.dupOf
    }

    it('reports a duplicate within a request when the top option is an item at 0.60 or more', () => {
      expect(
        decideDuplicate({ type: 'choice', choice: 'c1', probabilities: { c1: 0.6, none: 0.4 } }),
      ).toBe('c1')
      expect(
        decideDuplicate({ type: 'choice', choice: 'c1', probabilities: { c1: 0.55, none: 0.45 } }),
      ).toBeNull()
      expect(
        decideDuplicate({ type: 'choice', choice: 'none', probabilities: { c1: 0.2, none: 0.8 } }),
      ).toBeNull()
      expect(decideDuplicate({ type: 'choice', choice: 'c1' })).toBeNull()
    })

    it('matches identical text across requests after lower-casing and collapsing whitespace', () => {
      const decisions = decideItems({
        items: [
          item(1, 'Missing  null check\non `user`.'),
          item(2, 'Unrelated.'),
          item(3, 'missing null check on `user`.'),
        ],
        calls: [['c1', 'c2'], ['c3']],
        answers: { ...answers(1, 0.9), ...answers(2, 0.9), ...answers(3, 0.1) },
        cutoffs: BUILT_IN,
      })

      expect(decisions.map((decision) => decision.dupOf)).toEqual([null, null, 'c1'])
      expect(decisions[2]?.verdict).toBe('collapse')
    })

    it('reports duplicates by display id', () => {
      const first = { ...item(1), id: 'f-1' }
      const second = { ...item(2), id: 'f-2' }
      const [, decision] = decideItems({
        items: [first, second],
        calls: [['c1', 'c2']],
        answers: {
          ...answers(1, 0.9),
          ...answers(2, 0.9, {
            c2_dup: { type: 'choice', choice: 'c1', probabilities: { c1: 1 } },
          }),
        },
        cutoffs: BUILT_IN,
      })

      expect(decision?.dupOf).toBe('f-1')
    })
  })
})

describe('cut-off resolution', () => {
  const calibrated: CutoffInputs['userConfig'] = {
    collapse_below: 0.27,
    keep_at: 0.7,
    replay: 'public-v1',
    snapshot: SNAPSHOT,
    tested_collapse_below: 0.27,
    written_at: '2026-10-01',
  }

  it('uses the built-in uncalibrated band when nothing sets the cut-offs', () => {
    expect(describeCutoffs(resolveCutoffs({}), [SNAPSHOT])).toMatchObject({
      line: 'collapse<0.30 keep>=0.70 (built-in, uncalibrated)',
      warnings: [],
    })
  })

  it('resolves each cut-off separately: flag over repo config over user config over built-in', () => {
    const resolved = resolveCutoffs({
      flags: { collapseBelow: 0.2 },
      repoConfig: { collapse_below: 0.25, keep_at: 0.8 },
      userConfig: { collapse_below: 0.1, keep_at: 0.9 },
    })

    expect(resolved).toMatchObject({ collapseBelow: 0.2, keepAt: 0.8 })
    expect(describeCutoffs(resolved, [SNAPSHOT]).line).toBe(
      'collapse<0.20 keep>=0.80 (collapse: flag, hand-set; keep: repo config, hand-set)',
    )
  })

  it('reports calibration by replay for cut-offs a replay wrote to the user config', () => {
    expect(describeCutoffs(resolveCutoffs({ userConfig: calibrated }), [SNAPSHOT]).line).toBe(
      'collapse<0.27 keep>=0.70 (user config, calibrated on typesafe/jev-1.13-20260917 by replay public-v1)',
    )
  })

  it('reports hand-set user config cut-offs', () => {
    expect(
      describeCutoffs(resolveCutoffs({ userConfig: { collapse_below: 0.2, keep_at: 0.6 } }), [
        SNAPSHOT,
      ]).line,
    ).toBe('collapse<0.20 keep>=0.60 (user config, hand-set)')
  })

  it('marks calibrated cut-offs stale when the returned snapshot changed, and suggests a replay', () => {
    const description = describeCutoffs(resolveCutoffs({ userConfig: calibrated }), [
      'typesafe/jev-1.13-20261201',
    ])

    expect(description.line).toBe(
      'collapse<0.27 keep>=0.70 (user config, calibrated on typesafe/jev-1.13-20260917 by replay public-v1, stale)',
    )
    expect(description.warnings).toEqual([
      'calibrated cut-offs were measured on typesafe/jev-1.13-20260917, this run used typesafe/jev-1.13-20261201',
    ])
    expect(description.help).toEqual([
      'Run `quiet-review-axi replay public-v1` again to re-measure the cut-offs on the new model snapshot',
    ])
  })

  it('warns when the collapse cut-off is above the value the replay tested', () => {
    const description = describeCutoffs(
      resolveCutoffs({ flags: { collapseBelow: 0.35 }, userConfig: calibrated }),
      [SNAPSHOT],
    )

    expect(description.warnings).toEqual([
      'collapse cut-off 0.35 is above the 0.27 the last replay tested, so more real issues than the replay measured may be collapsed',
    ])
  })

  it('rejects cut-offs outside 0 <= collapse_below <= keep_at <= 1', () => {
    expect(() => resolveCutoffs({ flags: { collapseBelow: 0.8, keepAt: 0.5 } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(() => resolveCutoffs({ flags: { keepAt: 1.2 } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(() => resolveCutoffs({ repoConfig: { collapse_below: -0.1 } })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })
})
