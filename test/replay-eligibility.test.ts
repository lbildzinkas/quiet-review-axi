import { describe, expect, it } from 'vitest'
import { runReplay, setupReplay } from './helpers/replay.js'

describe('comment eligibility (spec 10.4)', () => {
  it('draws only thread-root comments by configured bots on PRs merged in the window, with an anchor and no summary', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100, bots: ['coderabbitai[bot]'] },
      specs: [
        {
          name: 'acme/widgets',
          merged: 31,
          bots: { 'coderabbitai[bot]': 11, 'greptile-apps[bot]': 11 },
          body: ({ pr }) =>
            pr === 1
              ? '<!-- walkthrough_start -->\n## Walkthrough\nThis PR adds retries.'
              : 'Possible null dereference.',
          comment: ({ pr }) => {
            if (pr === 2) return { line: null, original_line: null }
            if (pr === 3) return { diff_hunk: '' }
            if (pr === 5) return { line: null }
            return {}
          },
          replies: ({ bot, pr }) =>
            pr === 6 ? [{ login: bot, type: 'Bot', body: 'Also consider logging here.' }] : [],
          mergedAt: (pr) => (pr === 4 ? '2026-06-24T23:59:59Z' : '2026-08-01T12:00:00Z'),
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    // PRs 5-11: PR 5's comment is outdated but still anchored by its original line.
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 7 comments from 7 PRs"')
  })
})

describe('label evidence read from GitHub (spec 10.5)', () => {
  it('excludes a comment whose file was renamed or deleted after it', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          compareFile: ({ pr }, path) => {
            if (pr === 1)
              return { filename: 'src/moved.ts', previous_filename: path, status: 'renamed' }
            if (pr === 2) return { filename: path, status: 'removed', deletions: 100 }
            return null
          },
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 0, noise 8, excluded 2"')
    expect(result.stdout).toContain('file deleted,1')
    expect(result.stdout).toContain('file renamed,1')
  })

  it('labels an unchanged comment real when a person agreed and resolved the thread', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          resolved: ({ pr }) => pr <= 3,
          replies: ({ pr, bot }) => [
            ...(pr <= 2 ? [{ login: 'alice', body: 'Good catch, fixed in the caller.' }] : []),
            ...(pr === 4 ? [{ login: bot, type: 'Bot', body: 'Thanks, fixed!' }] : []),
          ],
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 2, noise 8, excluded 0"')
  })
})
