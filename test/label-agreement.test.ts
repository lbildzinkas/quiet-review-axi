import { describe, expect, it } from 'vitest'
import { agreementOf, type AiLabel } from '../src/replay/label-check.js'
import type { Label } from '../src/replay/label.js'

function pairs(counts: [Label, AiLabel, number][]) {
  return counts.flatMap(([automatic, ai, count]) =>
    Array.from({ length: count }, () => ({ automatic, ai })),
  )
}

describe('label-check agreement (spec 10.6 step 3)', () => {
  it("reports raw agreement and Cohen's kappa against a hand-computed table", () => {
    // Automatic real 6, noise 4; the AI agrees on 5 real and 3 noise.
    // p_o = 8/10 = 0.8; p_e = 0.6 * 0.6 + 0.4 * 0.4 = 0.52; kappa = 0.28 / 0.48 = 0.5833...
    const result = agreementOf(
      pairs([
        ['real', 'real', 5],
        ['real', 'noise', 1],
        ['noise', 'real', 1],
        ['noise', 'noise', 3],
      ]),
    )

    expect(result.compared).toBe(10)
    expect(result.agreement).toBe(0.8)
    expect(result.kappa).toBeCloseTo(0.58333, 5)
  })

  it('leaves out the items the AI answered unsure', () => {
    // p_o = 3/4; p_e = 0.5 * 0.25 + 0.5 * 0.75 = 0.5; kappa = 0.25 / 0.5 = 0.5.
    const result = agreementOf(
      pairs([
        ['real', 'real', 1],
        ['real', 'noise', 1],
        ['noise', 'noise', 2],
        ['real', 'unsure', 3],
      ]),
    )

    expect(result).toEqual({ compared: 4, agreement: 0.75, kappa: 0.5 })
  })

  it('gives kappa below zero when the two labellers agree less than chance', () => {
    // p_o = 0; p_e = 0.5 * 0.5 + 0.5 * 0.5 = 0.5; kappa = -0.5 / 0.5 = -1.
    expect(
      agreementOf(
        pairs([
          ['real', 'noise', 2],
          ['noise', 'real', 2],
        ]),
      ).kappa,
    ).toBe(-1)
  })

  it('has no kappa when both labellers used one label only, and no agreement without labels', () => {
    expect(agreementOf(pairs([['real', 'real', 3]]))).toEqual({
      compared: 3,
      agreement: 1,
      kappa: null,
    })
    expect(agreementOf(pairs([['noise', 'unsure', 2]]))).toEqual({
      compared: 0,
      agreement: null,
      kappa: null,
    })
  })
})
