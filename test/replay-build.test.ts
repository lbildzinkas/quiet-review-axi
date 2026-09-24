import { readFileSync, rmSync } from 'node:fs'
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

  it.each([
    [{ surprise: true }, 'Unrecognized key'],
    [{ max_share_per_bot: 1.5 }, 'max_share_per_bot'],
    [{ window: { merged_after: '2026-09-23', merged_before: '2026-06-25' } }, 'merged_after'],
    [{ repositories: ['not-a-repo'] }, 'owner/repo'],
    [{ name: 'other' }, 'named other'],
  ])('rejects an invalid config %j with exit 2', async (override, message) => {
    const { sandbox, gitHub } = setup({ config: override })
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify(config(override)))

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain(message)
    expect(result.fetchCalls).toHaveLength(0)
  })

  it('records the pre-registration hash of the config it built', async () => {
    const { sandbox, gitHub } = setup()

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toMatch(/config_hash: "sha256:[0-9a-f]{64}"/)
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

    const result = await replay(['public-v1'], sandbox, gitHub)

    // PRs 5-11: PR 5's comment is outdated but still anchored by its original line.
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 7 comments from 7 PRs"')
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

describe('GitHub cache in the replay directory (spec 8.1, 9.2)', () => {
  it('rebuilds from cached GitHub responses with no network call and identical output', async () => {
    const { sandbox, gitHub } = setup()
    const dir = join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1')
    const first = await replay(['public-v1'], sandbox, gitHub)
    const items = readFileSync(join(dir, 'items.jsonl'), 'utf8')
    rmSync(join(dir, 'manifest.json'))
    rmSync(join(dir, 'items.jsonl'))
    const sleeps: number[] = []

    const rebuilt = await runCli(['replay', 'public-v1'], {
      sandbox,
      env: TOKEN,
      sleep: async (ms) => void sleeps.push(ms),
    })

    expect(rebuilt.exitCode).toBe(0)
    expect(rebuilt.fetchCalls).toHaveLength(0)
    expect(sleeps).toEqual([])
    expect(readFileSync(join(dir, 'items.jsonl'), 'utf8')).toBe(items)
    expect(rebuilt.stdout).toBe(first.stdout)
  })

  it('spaces out searches that reach the network: one count and one per bot here', async () => {
    const { sandbox, gitHub } = setup({ config: { bots: ['coderabbitai[bot]', 'cursor[bot]'] } })
    const sleeps: number[] = []

    await runCli(['replay', 'public-v1'], {
      sandbox,
      env: TOKEN,
      fetch: gitHub.handle,
      sleep: async (ms) => void sleeps.push(ms),
    })

    expect(sleeps).toEqual([2000, 2000])
  })

  it('never writes the GitHub token to the replay directory', async () => {
    const { sandbox, gitHub } = setup()

    await replay(['public-v1'], sandbox, gitHub)

    const written = sandbox.writtenFiles().filter((file) => file.path.includes('.quiet-review'))
    expect(written.some((file) => file.path.includes('github'))).toBe(true)
    expect(written.filter((file) => file.content.includes(TOKEN.GITHUB_TOKEN))).toEqual([])
  })
})

describe('repository and bot qualification (spec 10.3)', () => {
  const BOT = 'coderabbitai[bot]'

  it('rejects repositories that miss any criterion, logging each with its reason', async () => {
    const repositories = [
      'acme/widgets',
      'acme/secret',
      'acme/old',
      'someone/widgets-fork',
      'acme/quiet',
      'acme/rare',
      'acme/foreign',
      'coderabbitai/tools',
      'acme/missing',
    ]
    const { sandbox, gitHub } = setup({
      config: { repositories, target_items: 100 },
      specs: [
        { name: 'acme/widgets', bots: { [BOT]: 10 } },
        { name: 'acme/secret', bots: { [BOT]: 10 }, repository: { private: true } },
        { name: 'acme/old', bots: { [BOT]: 10 }, repository: { archived: true } },
        { name: 'someone/widgets-fork', bots: { [BOT]: 10 }, repository: { fork: true } },
        { name: 'acme/quiet', merged: 29, bots: { [BOT]: 10 } },
        { name: 'acme/rare', bots: { [BOT]: 9 } },
        { name: 'acme/foreign', bots: { [BOT]: 10 }, title: (pr) => `修复小部件处理问题 ${pr}` },
        { name: 'coderabbitai/tools', bots: { [BOT]: 10 } },
      ],
    })

    const result = await replay(['public-v1'], sandbox, gitHub)

    const rejected = [
      'repository,acme/secret,private',
      'repository,acme/old,archived',
      'repository,someone/widgets-fork,fork',
      'repository,acme/quiet,"29 merged PRs in the window, needs 30"',
      'repository,acme/rare,"no listed bot left inline comments on 10 merged PRs (most: coderabbitai[bot] on 9)"',
      'repository,acme/foreign,not mainly English',
      'repository,coderabbitai/tools,"owned by the vendor of coderabbitai[bot]"',
      'repository,acme/missing,not found or not visible to the token',
    ]
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 10 comments from 10 PRs"')
    expect(result.stdout).toContain(
      `rejected[8]{kind,candidate,reason}:\n${rejected.map((row) => `  ${row}`).join('\n')}`,
    )
    const log = readJsonl(join(sandbox.cwd, '.quiet-review/replays/public-v1/build-log.jsonl'))
    expect(log).toHaveLength(8)
    expect(log[0]).toEqual({ kind: 'repository', candidate: 'acme/secret', reason: 'private' })
  })

  it('rejects a listed bot that left no inline comments in the qualifying repositories', async () => {
    const { sandbox, gitHub } = setup({ config: { bots: [BOT, 'cursor[bot]'] } })

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain(
      'bot,"cursor[bot]",no inline review comments in the qualifying repositories in the window',
    )
  })

  it('warns when the dataset covers fewer than 3 bots or 5 repositories', async () => {
    const { sandbox, gitHub } = setup()

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('covers 1 bot')
    expect(result.stdout).toContain('covers 1 repository')
  })
})

describe('candidate discovery (spec 10.3)', () => {
  const BOT = 'coderabbitai[bot]'
  const specs: RepositorySpec[] = [
    { name: 'acme/widgets', bots: { [BOT]: 12, 'cursor[bot]': 10 } },
    { name: 'acme/rare', bots: { [BOT]: 5 } },
    { name: 'acme/old', bots: { [BOT]: 10 }, repository: { archived: true } },
  ]

  it('searches for candidates when the config lists no repositories, and builds nothing yet', async () => {
    const { sandbox, gitHub } = setup({
      specs,
      config: { repositories: [], bots: [BOT, 'cursor[bot]'] },
    })

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'build,waiting,1 of 3 candidates qualify; list 5-8 in the config',
    )
    expect(result.stdout).toContain('label,pending')
    expect(result.stdout).toContain(
      'candidates[1]{repository,merged_prs,bot_prs}:\n  acme/widgets,30,"coderabbitai[bot] 12, cursor[bot] 10"',
    )
    expect(result.stdout).toContain('repository,acme/old,archived')
    expect(result.stdout).toContain(
      'repository,acme/rare,"no listed bot left inline comments on 10 merged PRs (most: coderabbitai[bot] on 5)"',
    )
    expect(result.stdout).toContain('`repositories`')
    expect(gitHub.requests.some((request) => request.url.includes('/pulls/'))).toBe(false)
  })

  it('builds once the chosen repositories are written into the config', async () => {
    const { sandbox, gitHub } = setup({ specs, config: { repositories: [] } })
    await replay(['public-v1'], sandbox, gitHub)
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify(config()))

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 4 comments from 4 PRs"')
  })
})

describe('replay output', () => {
  it('counts exclusions by reason', async () => {
    const { sandbox, gitHub } = setup({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          comment: ({ pr }) => (pr <= 2 ? { side: 'LEFT' } : {}),
          replies: ({ pr }) =>
            pr === 3 ? [{ login: 'alice', body: 'Thanks! Though this is by design.' }] : [],
        },
      ],
    })

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 3, noise 4, excluded 3"')
    expect(result.stdout).toContain(
      'excluded[2]{reason,count}:\n  anchor unmapped,2\n  conflicting replies,1',
    )
  })

  it('emits one JSON document with --json and writes progress to stderr', async () => {
    const { sandbox, gitHub } = setup()

    const result = await replay(['public-v1', '--json'], sandbox, gitHub)

    const document = JSON.parse(result.stdout) as Record<string, unknown>
    expect(document.replay).toBe('public-v1')
    expect(document.stages).toContainEqual({
      stage: 'label',
      status: 'done',
      detail: 'real 2, noise 2, excluded 0',
    })
    expect(result.stderr).toContain('build: checking acme/widgets')
  })

  it('explains the stages and flags with --help', async () => {
    const result = await runCli(['replay', '--help'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--stage <build|label|check|score|evaluate>')
    expect(result.stdout).toContain('--config <file>')
    expect(result.stdout).toContain('--dir <path>')
  })

  it('maps GitHub failures to exit 4 and leaves the build to resume', async () => {
    const { sandbox } = setup()

    const missing = await runCli(['replay', 'public-v1'], { sandbox })
    const rejected = await runCli(['replay', 'public-v1'], {
      sandbox,
      env: TOKEN,
      fetch: async () => new Response('{"message":"Bad credentials"}', { status: 401 }),
    })

    expect(missing.exitCode).toBe(4)
    expect(missing.stdout).toContain('code: MISSING_GITHUB_TOKEN')
    expect(rejected.exitCode).toBe(4)
    expect(rejected.stdout).toContain('code: GITHUB_AUTH')
    expect(rejected.stdout).not.toContain(TOKEN.GITHUB_TOKEN)
  })
})

describe('label evidence read from GitHub (spec 10.5)', () => {
  it('excludes a comment whose file was renamed or deleted after it', async () => {
    const { sandbox, gitHub } = setup({
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

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 0, noise 8, excluded 2"')
    expect(result.stdout).toContain('file deleted,1')
    expect(result.stdout).toContain('file renamed,1')
  })

  it('labels an unchanged comment real when a person agreed and resolved the thread', async () => {
    const { sandbox, gitHub } = setup({
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

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 2, noise 8, excluded 0"')
  })
})

describe('long rejection lists', () => {
  it('prints the first 20 rejections and points to the build log for the rest', async () => {
    const specs: RepositorySpec[] = Array.from({ length: 25 }, (_, index) => ({
      name: `acme/tiny-${String(index).padStart(2, '0')}`,
      bots: { 'coderabbitai[bot]': 2 },
    }))
    const { sandbox, gitHub } = setup({ specs, config: { repositories: [] } })

    const result = await replay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('rejected_total: 25')
    expect(result.stdout).toContain('rejected[20]{kind,candidate,reason}:')
    expect(result.stdout).toContain('acme/tiny-19')
    expect(result.stdout).not.toContain('acme/tiny-20')
    expect(result.stdout).toContain('.quiet-review/replays/public-v1/build-log.jsonl')
    const log = readJsonl(join(sandbox.cwd, '.quiet-review/replays/public-v1/build-log.jsonl'))
    expect(log).toHaveLength(25)
  })
})
