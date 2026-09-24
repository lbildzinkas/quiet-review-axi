import { describe, expect, it } from 'vitest'
import { buildWorld, config, type RepositorySpec } from './fixtures/github/replay-world.js'
import { createFakeGitHubReplay } from './helpers/fake-github-replay.js'
import { createSandbox, runCli, type Sandbox } from './helpers/run-cli.js'

const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }

function setup(options: { specs?: RepositorySpec[]; config?: Record<string, unknown> } = {}) {
  const sandbox = createSandbox()
  const replayConfig = config(options.config)
  sandbox.write(`work/replay/${replayConfig.name}.config.json`, JSON.stringify(replayConfig))
  const gitHub = createFakeGitHubReplay(
    buildWorld(options.specs ?? [{ name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 } }]),
  )
  return { sandbox, gitHub }
}

function replay(
  argv: string[],
  sandbox: Sandbox,
  gitHub?: ReturnType<typeof createFakeGitHubReplay>,
) {
  return runCli(['replay', ...argv], {
    sandbox,
    env: TOKEN,
    ...(gitHub ? { fetch: gitHub.handle } : {}),
  })
}

describe('replay config', () => {
  it('refuses to start without the replay config, naming where it looked', async () => {
    const result = await replay(['public-v1'], createSandbox())

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain('replay/public-v1.config.json')
  })
})

describe('replay build and label', () => {
  it('builds the dataset from the configured repository and labels every drawn comment', async () => {
    const { sandbox, gitHub } = setup({
      specs: [{ name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 }, changed: () => true }],
    })

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('replay: public-v1')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 4 comments from 4 PRs"')
    expect(result.stdout).toContain('label,done,"real 4, noise 0, excluded 0"')
  })
})

describe('comment eligibility (spec 10.4)', () => {
  it('draws only thread-root comments by configured bots on PRs merged in the window, with an anchor and no summary', async () => {
    const { sandbox, gitHub } = setup({
      config: { target_items: 100, bots: ['coderabbitai[bot]'] },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10, 'greptile-apps[bot]': 10 },
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

    const result = await replay(['public-v1'], sandbox, gitHub)

    // PRs 5-10: PR 5's comment is outdated but still anchored by its original line.
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 6 comments from 6 PRs"')
  })
})
