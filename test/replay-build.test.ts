import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWorld, config, type RepositorySpec } from './fixtures/github/replay-world.js'
import { createFakeGitHubReplay } from './helpers/fake-github-replay.js'
import { createSandbox, runCli, type Sandbox } from './helpers/run-cli.js'

const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }
const REPO_ROOT = join(import.meta.dirname, '..')

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

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

describe('replay directory and stages (spec 4.6, 10.9)', () => {
  it('writes the dataset and its labels under the git-ignored .quiet-review directory', async () => {
    const { sandbox, gitHub } = setup()

    const result = await replay(['public-v1'], sandbox, gitHub)

    const dir = join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1')
    expect(result.stdout).toContain('dir: .quiet-review/replays/public-v1')
    expect(readJsonl(join(dir, 'items.jsonl'))).toHaveLength(4)
    expect(readJsonl(join(dir, 'labels.jsonl')).map((line) => Object.keys(line))).toEqual(
      Array(4).fill(['id', 'label', 'reason', 'signals']),
    )
    expect(readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8').split('\n')).toContain(
      '.quiet-review/',
    )
  })
  it('treats a re-run of completed stages with unchanged inputs as a no-op', async () => {
    const { sandbox, gitHub } = setup()
    const first = await replay(['public-v1'], sandbox, gitHub)

    const second = await replay(['public-v1'], sandbox, gitHub)

    expect(second.exitCode).toBe(0)
    expect(second.fetchCalls).toHaveLength(0)
    expect(second.stdout).toBe(first.stdout)
  })

  it('refuses a changed config after build, protecting the pre-registration', async () => {
    const { sandbox, gitHub } = setup()
    await replay(['public-v1'], sandbox, gitHub)
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify(config({ seed: 7 })))

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain('changed after build')
    expect(result.stdout).toContain('new replay name')
    expect(result.fetchCalls).toHaveLength(0)
  })
  it('runs one stage with --stage, and refuses label before build', async () => {
    const { sandbox, gitHub } = setup()

    const early = await replay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    const build = await replay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    const label = await replay(['public-v1', '--stage', 'label'], sandbox, gitHub)

    expect(early.exitCode).toBe(2)
    expect(early.stdout).toContain('--stage build')
    expect(build.stdout).toContain('label,pending')
    expect(label.stdout).toContain('label,done,')
    expect(label.fetchCalls).toHaveLength(0)
  })

  it('reports the later stages as not available yet and refuses to run them', async () => {
    const { sandbox, gitHub } = setup()

    const all = await replay(['public-v1'], sandbox, gitHub)
    const check = await replay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    expect(all.stdout).toContain('check,unavailable')
    expect(all.stdout).toContain('evaluate,unavailable')
    expect(check.exitCode).toBe(2)
    expect(check.stdout).toContain('not available in this version')
  })

  it('keeps the replay in --dir and reads the config from --config', async () => {
    const { sandbox, gitHub } = setup()
    sandbox.write('work/configs/other.json', JSON.stringify(config()))

    const result = await replay(
      ['public-v1', '--config', 'configs/other.json', '--dir', 'data/r1'],
      sandbox,
      gitHub,
    )

    expect(result.stdout).toContain('dir: data/r1')
    expect(result.stdout).toContain('config: configs/other.json')
    expect(readJsonl(join(sandbox.cwd, 'data', 'r1', 'labels.jsonl'))).toHaveLength(4)
  })
})
