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
    [
      { label_check: { sample_size: 60, backend: 'pi', model: 'zai-coding-cn/glm-5.3' } },
      'label_check.thinking is required with backend pi',
    ],
    [
      { label_check: { sample_size: 60, backend: 'pi', model: 'm', thinking: 'extreme' } },
      'label_check.thinking',
    ],
    [
      { label_check: { sample_size: 60, model: 'example/label-model', thinking: 'max' } },
      'label_check.thinking is only for backend pi',
    ],
    [
      { label_check: { sample_size: 60, backend: 'claude', model: 'sonnet' } },
      'label_check.backend',
    ],
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

  it('keeps the pre-registration hash of a config that names no label backend', async () => {
    const { sandbox, gitHub } = setupReplay()

    const result = await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)

    // The hash this config had before label_check.backend existed.
    expect(result.stdout).toContain(
      'config_hash: "sha256:6ac81a15e398614013362aa5cc998323954d721d5732e295a0b23d27ca893ddc"',
    )
  })
})
