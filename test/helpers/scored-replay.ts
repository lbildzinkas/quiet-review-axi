import { createFakeJev, setupReplay } from './replay.js'

// Worth per pull request: odd PRs are real, even ones noise. One real comment (PR 5, 0.35)
// scores below one noise comment (PR 6, 0.4): AUROC 24/25 = 0.96, and the best threshold
// that hides no real comment is 0.31, which collapses 4 of 5 noise comments.
export const WORTH: Record<number, number> = {
  1: 0.9,
  2: 0.1,
  3: 0.8,
  4: 0.2,
  5: 0.35,
  6: 0.4,
  7: 0.7,
  8: 0.05,
  9: 0.95,
  10: 0.3,
}

// A fake Jev that scores the comment on part N of the world below as `worth[N]`.
export function jevByPart(
  worth: Record<number, number>,
  options: Parameters<typeof createFakeJev>[0] = {},
) {
  return createFakeJev({
    ...options,
    byComment: (comment) => ({ act: worth[Number(comment.split(' ').at(-1))] ?? 0.5 }),
  })
}

// Ten merged PRs, one bot comment each ("Comment on part N"), ready to replay end to end.
export function scoredReplay(name = 'public-v1') {
  const setup = setupReplay({
    config: { name, target_items: 100 },
    specs: [
      {
        name: 'acme/widgets',
        bots: { 'coderabbitai[bot]': 10 },
        body: ({ pr }) => `Comment on part ${pr}`,
      },
    ],
  })
  return { ...setup, jev: jevByPart(WORTH) }
}

// Ten PRs scored by part (odd real, even noise), with a 4-item label-check sample. The seeded
// sample draws PRs 7 and 9 (real, worth 0.7 and 0.95) and PRs 2 and 10 (noise, 0.1 and 0.3):
// every sampled real item outscores every sampled noise item, unlike the full set (AUROC 0.96).
export function sampledReplay() {
  const { sandbox, gitHub } = setupReplay({
    config: { target_items: 100, label_check: { sample_size: 4, model: 'example/label-model' } },
    specs: [
      {
        name: 'acme/widgets',
        bots: { 'coderabbitai[bot]': 10 },
        body: ({ pr, id }) => `Comment (#${id}) on part ${pr}`,
      },
    ],
  })
  return { sandbox, gitHub, jev: jevByPart(WORTH) }
}
