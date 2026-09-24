import { describe, expect, it } from 'vitest'
import { config } from './fixtures/github/replay-world.js'
import { createSandbox, runReplay, setupReplay } from './helpers/replay.js'

describe('replay config', () => {
  it('refuses to start without the replay config, naming where it looked', async () => {
    const result = await runReplay(['public-v1'], createSandbox())

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain('replay/public-v1.config.json')
  })

  it.each([
    [{ surprise: true }, 'Unrecognized key'],
    [{ max_share_per_bot: 1.5 }, 'max_share_per_bot'],
    [{ window: { merged_after: '2026-09-23', merged_before: '2026-06-25' } }, 'merged_after'],
    [{ repositories: ['not-a-repo'] }, 'owner/repo'],
    [{ repositories: ['acme/widgets', 'acme/widgets'] }, 'must not repeat a repository'],
    [{ bots: ['coderabbitai[bot]', 'coderabbitai[bot]'] }, 'must not repeat a bot'],
    [{ name: 'other' }, 'named other'],
  ])('rejects an invalid config %j with exit 2', async (override, message) => {
    const { sandbox, gitHub } = setupReplay({ config: override })
    sandbox.write('work/replay/public-v1.config.json', JSON.stringify(config(override)))

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain(message)
    expect(result.fetchCalls).toHaveLength(0)
  })

  it('records the pre-registration hash of the config it built', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toMatch(/config_hash: "sha256:[0-9a-f]{64}"/)
  })
})
