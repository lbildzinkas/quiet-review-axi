import { seededRandom } from '../calibration/random.js'

// Capped, stratified, seeded sampling of eligible comments (spec 10.4).

export interface Candidate {
  // Unique and stable, for example `owner/repo#12/r345`.
  key: string
  repository: string
  bot: string
  pr: string
}

export interface SampleOptions<T extends Candidate> {
  candidates: T[]
  target: number
  maxSharePerRepository: number
  maxSharePerBot: number
  maxItemsPerPr: number
  seed: number
  // Decides whether a drawn candidate is excluded (spec 10.5). Excluded draws count toward
  // neither the target nor any cap.
  isExcluded: (candidate: T) => Promise<boolean>
}

export interface Draw<T extends Candidate> {
  candidate: T
  isExcluded: boolean
}

// 1. Group candidates into (repository, bot) strata. 2. Shuffle each with the seeded
// generator. 3. Draw round-robin, skipping a stratum once its repository or bot reaches its
// share cap, and a comment once its pull request reaches max_items_per_pr. 4. Stop at the
// target, or when every stratum is exhausted or capped.
export async function drawSample<T extends Candidate>(
  options: SampleOptions<T>,
): Promise<Draw<T>[]> {
  const random = seededRandom(options.seed)
  const strata = groupStrata(options.candidates).map((stratum) => shuffle(stratum, random))
  const repositoryCap = Math.floor(options.maxSharePerRepository * options.target)
  const botCap = Math.floor(options.maxSharePerBot * options.target)
  const counts = { repository: new Map<string, number>(), bot: new Map<string, number>() }
  const perPr = new Map<string, number>()
  const draws: Draw<T>[] = []
  let labelled = 0
  let isProgressing = true
  while (isProgressing && labelled < options.target) {
    isProgressing = false
    for (const stratum of strata) {
      if (labelled >= options.target) break
      const head = stratum[0]
      if (!head) continue
      if ((counts.repository.get(head.repository) ?? 0) >= repositoryCap) continue
      if ((counts.bot.get(head.bot) ?? 0) >= botCap) continue
      const candidate = nextOpen(stratum, perPr, options.maxItemsPerPr)
      if (!candidate) continue
      isProgressing = true
      const isExcluded = await options.isExcluded(candidate)
      draws.push({ candidate, isExcluded })
      if (isExcluded) continue
      labelled++
      increment(counts.repository, candidate.repository)
      increment(counts.bot, candidate.bot)
      increment(perPr, candidate.pr)
    }
  }
  return draws
}

// Removes and returns the stratum's next candidate whose pull request is under its cap.
// Candidates of a capped pull request are dropped: the count never goes down.
function nextOpen<T extends Candidate>(
  stratum: T[],
  perPr: Map<string, number>,
  maxItemsPerPr: number,
): T | undefined {
  for (;;) {
    const candidate = stratum.shift()
    if (!candidate || (perPr.get(candidate.pr) ?? 0) < maxItemsPerPr) return candidate
  }
}

// Strata in (repository, bot) order, each sorted by key, so the input order never matters.
function groupStrata<T extends Candidate>(candidates: T[]): T[][] {
  const strata = new Map<string, T[]>()
  for (const candidate of candidates) {
    const key = `${candidate.repository}\u0000${candidate.bot}`
    strata.set(key, [...(strata.get(key) ?? []), candidate])
  }
  return [...strata.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, members]) => members.sort((a, b) => compareText(a.key, b.key)))
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const current = shuffled[index] as T
    shuffled[index] = shuffled[other] as T
    shuffled[other] = current
  }
  return shuffled
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
