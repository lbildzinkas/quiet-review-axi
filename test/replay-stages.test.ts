import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config } from './fixtures/github/replay-world.js'
import { readJsonl, runCli, runReplay, setupReplay, TOKEN } from './helpers/replay.js'

const REPO_ROOT = join(import.meta.dirname, '..')

describe('replay build and label', () => {
  it('builds the dataset from the configured repository and labels every drawn comment', async () => {
    const { sandbox, gitHub } = setupReplay({
      specs: [{ name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 }, changed: () => true }],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('replay: public-v1')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 4 comments from 4 PRs"')
    expect(result.stdout).toContain('label,done,"real 4, noise 0, excluded 0"')
  })
})

describe('replay directory and stages (spec 4.6, 10.9)', () => {
  it('writes the dataset and its labels under the git-ignored .quiet-review directory', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runReplay(['public-v1'], sandbox, gitHub)

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
    const { sandbox, gitHub } = setupReplay()
    const first = await runReplay(['public-v1'], sandbox, gitHub)

    const second = await runReplay(['public-v1'], sandbox, gitHub)

    expect(second.exitCode).toBe(0)
    expect(second.fetchCalls).toHaveLength(0)
    expect(second.stdout).toBe(first.stdout)
  })

  it('refuses a changed config after build, protecting the pre-registration', async () => {
    const { sandbox, gitHub } = setupReplay()
    await runReplay(['public-v1'], sandbox, gitHub)
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify(config({ seed: 7 })))

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain('changed after build')
    expect(result.stdout).toContain('new replay name')
    expect(result.fetchCalls).toHaveLength(0)
  })
  it('runs one stage with --stage, and refuses label before build', async () => {
    const { sandbox, gitHub } = setupReplay()

    const early = await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    const build = await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    const label = await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)

    expect(early.exitCode).toBe(2)
    expect(early.stdout).toContain('--stage build')
    expect(build.stdout).toContain('label,pending')
    expect(label.stdout).toContain('label,done,')
    expect(label.fetchCalls).toHaveLength(0)
  })

  it('reports the check stage as not available yet and refuses to run it', async () => {
    const { sandbox, gitHub } = setupReplay()

    const all = await runReplay(['public-v1'], sandbox, gitHub)
    const check = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)

    expect(all.stdout).toContain('check,unavailable')
    expect(check.exitCode).toBe(2)
    expect(check.stdout).toContain('not available in this version')
  })

  it('keeps the replay in --dir and reads the config from --config', async () => {
    const { sandbox, gitHub } = setupReplay()
    sandbox.write('work/configs/other.json', JSON.stringify(config()))

    const result = await runReplay(
      ['public-v1', '--config', 'configs/other.json', '--dir', 'data/r1'],
      sandbox,
      gitHub,
    )

    expect(result.stdout).toContain('dir: data/r1')
    expect(result.stdout).toContain('config: configs/other.json')
    expect(readJsonl(join(sandbox.cwd, 'data', 'r1', 'labels.jsonl'))).toHaveLength(4)
  })
})

describe('replay output', () => {
  it('counts exclusions by reason', async () => {
    const { sandbox, gitHub } = setupReplay({
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

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 3, noise 4, excluded 3"')
    expect(result.stdout).toContain(
      'excluded[2]{reason,count}:\n  anchor unmapped,2\n  conflicting replies,1',
    )
  })

  it('emits one JSON document with --json and writes progress to stderr', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runReplay(['public-v1', '--json'], sandbox, gitHub)

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
    const { sandbox } = setupReplay()

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
