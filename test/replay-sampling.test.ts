import { describe, expect, it } from 'vitest'
import { drawSample, type Candidate, type SampleOptions } from '../src/replay/sample.js'

// `count` candidates in one (repository, bot) stratum, each on its own pull request unless
// `perPr` groups them.
function stratum(repository: string, bot: string, count: number, perPr = 1): Candidate[] {
  return Array.from({ length: count }, (_, index) => {
    const pr = `${repository}#${Math.floor(index / perPr) + 1}`
    return { key: `${pr}/r${bot}-${index}`, repository, bot, pr }
  })
}

function options(
  candidates: Candidate[],
  overrides: Partial<SampleOptions<Candidate>> = {},
): SampleOptions<Candidate> {
  return {
    candidates,
    target: 10,
    maxSharePerRepository: 1,
    maxSharePerBot: 1,
    maxItemsPerPr: 8,
    seed: 20260923,
    isExcluded: async () => false,
    ...overrides,
  }
}

async function labelled(sampleOptions: SampleOptions<Candidate>) {
  const draws = await drawSample(sampleOptions)
  return draws.filter((draw) => !draw.isExcluded).map((draw) => draw.candidate)
}

function countBy(candidates: Candidate[], field: 'repository' | 'bot') {
  const counts: Record<string, number> = {}
  for (const candidate of candidates) counts[candidate[field]] = (counts[candidate[field]] ?? 0) + 1
  return counts
}

describe('sampling (spec 10.4)', () => {
  it('draws the same comments in the same order for the same seed, whatever the input order', async () => {
    const candidates = [...stratum('a/x', 'bot1', 30), ...stratum('b/y', 'bot2', 30)]

    const first = await labelled(options(candidates))
    const shuffled = await labelled(options([...candidates].reverse()))
    const otherSeed = await labelled(options(candidates, { seed: 7 }))

    expect(shuffled.map((c) => c.key)).toEqual(first.map((c) => c.key))
    expect(otherSeed.map((c) => c.key)).not.toEqual(first.map((c) => c.key))
  })

  it('draws round-robin across (repository, bot) strata', async () => {
    const candidates = [
      ...stratum('a/x', 'bot1', 50),
      ...stratum('a/x', 'bot2', 50),
      ...stratum('b/y', 'bot1', 50),
    ]

    const drawn = await labelled(options(candidates, { target: 9 }))

    expect(countBy(drawn, 'repository')).toEqual({ 'a/x': 6, 'b/y': 3 })
    expect(countBy(drawn, 'bot')).toEqual({ bot1: 6, bot2: 3 })
  })

  it('stops a repository at its share of the target, shrinking the dataset rather than breaking the cap', async () => {
    const candidates = [...stratum('a/x', 'bot1', 50), ...stratum('b/y', 'bot1', 50)]

    const drawn = await labelled(options(candidates, { target: 8, maxSharePerRepository: 0.25 }))

    expect(countBy(drawn, 'repository')).toEqual({ 'a/x': 2, 'b/y': 2 })
  })

  it('with only 3 bots and a 25% cap, stops at 225 of a 300-item target', async () => {
    const candidates = ['bot1', 'bot2', 'bot3'].flatMap((bot) =>
      ['a/x', 'b/y', 'c/z', 'd/w', 'e/v'].flatMap((repository) => stratum(repository, bot, 40)),
    )

    const drawn = await labelled(
      options(candidates, { target: 300, maxSharePerBot: 0.25, maxSharePerRepository: 0.25 }),
    )

    expect(drawn).toHaveLength(225)
    expect(countBy(drawn, 'bot')).toEqual({ bot1: 75, bot2: 75, bot3: 75 })
  })

  it('keeps a huge stratum from dominating when the others are small', async () => {
    const candidates = [
      ...stratum('big/repo', 'bot1', 1000),
      ...stratum('s/one', 'bot2', 3),
      ...stratum('s/two', 'bot3', 3),
    ]

    const drawn = await labelled(options(candidates, { target: 20, maxSharePerRepository: 0.5 }))

    expect(countBy(drawn, 'repository')).toEqual({ 'big/repo': 10, 's/one': 3, 's/two': 3 })
  })

  it('draws at most max_items_per_pr comments from one pull request', async () => {
    const candidates = [...stratum('a/x', 'bot1', 20, 20), ...stratum('b/y', 'bot1', 20)]

    const drawn = await labelled(options(candidates, { target: 30, maxItemsPerPr: 8 }))

    expect(countBy(drawn, 'repository')).toEqual({ 'a/x': 8, 'b/y': 20 })
  })

  it('does not count excluded comments toward the target or the caps', async () => {
    const candidates = [...stratum('a/x', 'bot1', 40), ...stratum('b/y', 'bot1', 40)]
    const isExcluded = async (candidate: Candidate) =>
      Number(candidate.key.split('-').pop()) % 2 === 0

    const draws = await drawSample(
      options(candidates, { target: 10, maxSharePerRepository: 0.5, isExcluded }),
    )
    const kept = draws.filter((draw) => !draw.isExcluded).map((draw) => draw.candidate)

    expect(kept).toHaveLength(10)
    expect(countBy(kept, 'repository')).toEqual({ 'a/x': 5, 'b/y': 5 })
    expect(draws.length).toBeGreaterThan(10)
  })

  it('stops when every stratum is exhausted', async () => {
    const drawn = await labelled(options(stratum('a/x', 'bot1', 3), { target: 10 }))

    expect(drawn).toHaveLength(3)
  })
})
