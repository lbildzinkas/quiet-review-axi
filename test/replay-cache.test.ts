import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, runReplay, setupReplay, TOKEN } from './helpers/replay.js'

describe('GitHub cache in the replay directory (spec 8.1, 9.2)', () => {
  it('rebuilds from cached GitHub responses with no network call and identical output', async () => {
    const { sandbox, gitHub } = setupReplay()
    const dir = join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1')
    const first = await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    const items = readFileSync(join(dir, 'items.jsonl'), 'utf8')
    rmSync(join(dir, 'manifest.json'))
    rmSync(join(dir, 'items.jsonl'))
    const sleeps: number[] = []

    const rebuilt = await runCli(['replay', 'public-v1', '--stage', 'build'], {
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
    const { sandbox, gitHub } = setupReplay({
      config: { bots: ['coderabbitai[bot]', 'cursor[bot]'] },
    })
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
    const { sandbox, gitHub } = setupReplay()

    await runReplay(['public-v1'], sandbox, gitHub)

    const written = sandbox.writtenFiles().filter((file) => file.path.includes('.quiet-review'))
    expect(written.some((file) => file.path.includes('github'))).toBe(true)
    expect(written.filter((file) => file.content.includes(TOKEN.GITHUB_TOKEN))).toEqual([])
  })
})
