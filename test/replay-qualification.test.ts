import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, type RepositorySpec } from './fixtures/github/replay-world.js'
import { readJsonl, runReplay, setupReplay } from './helpers/replay.js'

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
    const { sandbox, gitHub } = setupReplay({
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

    const result = await runReplay(['public-v1'], sandbox, gitHub)

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
    const { sandbox, gitHub } = setupReplay({ config: { bots: [BOT, 'cursor[bot]'] } })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain(
      'bot,"cursor[bot]",no inline review comments in the qualifying repositories in the window',
    )
  })

  it('warns when the dataset covers fewer than 3 bots or 5 repositories', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runReplay(['public-v1'], sandbox, gitHub)

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
    const { sandbox, gitHub } = setupReplay({
      specs,
      config: { repositories: [], bots: [BOT, 'cursor[bot]'] },
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

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
    const { sandbox, gitHub } = setupReplay({ specs, config: { repositories: [] } })
    await runReplay(['public-v1'], sandbox, gitHub)
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify(config()))

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 4 comments from 4 PRs"')
  })
})

describe('long rejection lists', () => {
  it('prints the first 20 rejections and points to the build log for the rest', async () => {
    const specs: RepositorySpec[] = Array.from({ length: 25 }, (_, index) => ({
      name: `acme/tiny-${String(index).padStart(2, '0')}`,
      bots: { 'coderabbitai[bot]': 2 },
    }))
    const { sandbox, gitHub } = setupReplay({ specs, config: { repositories: [] } })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('rejected_total: 25')
    expect(result.stdout).toContain('rejected[20]{kind,candidate,reason}:')
    expect(result.stdout).toContain('acme/tiny-19')
    expect(result.stdout).not.toContain('acme/tiny-20')
    expect(result.stdout).toContain('.quiet-review/replays/public-v1/build-log.jsonl')
    const log = readJsonl(join(sandbox.cwd, '.quiet-review/replays/public-v1/build-log.jsonl'))
    expect(log).toHaveLength(25)
  })
})
