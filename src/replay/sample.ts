// Sampling of eligible comments (spec 10.4).

export interface Candidate {
  // Unique and stable: `owner/repo#pr/r<comment id>`.
  key: string
  repository: string
  bot: string
  pr: string
}

export interface SampleOptions<T extends Candidate> {
  candidates: T[]
  target: number
  // Decides whether a drawn candidate is labelled or excluded (spec 10.5).
  isExcluded: (candidate: T) => Promise<boolean>
}

export interface Draw<T extends Candidate> {
  candidate: T
  isExcluded: boolean
}

export async function drawSample<T extends Candidate>(
  options: SampleOptions<T>,
): Promise<Draw<T>[]> {
  const draws: Draw<T>[] = []
  let labelled = 0
  for (const candidate of options.candidates) {
    if (labelled >= options.target) break
    const isExcluded = await options.isExcluded(candidate)
    draws.push({ candidate, isExcluded })
    if (!isExcluded) labelled++
  }
  return draws
}
