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
