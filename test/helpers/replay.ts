import { readFileSync } from 'node:fs'
import { buildWorld, config, type RepositorySpec } from '../fixtures/github/replay-world.js'
import { createFakeGitHubReplay } from './fake-github-replay.js'
import { createSandbox, runCli, type Sandbox } from './run-cli.js'

export const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }

export type FakeGitHubReplay = ReturnType<typeof createFakeGitHubReplay>

export function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// A sandbox holding replay/<name>.config.json and a fake GitHub serving the given world
// (by default one busy repository where coderabbitai[bot] commented on 10 merged PRs).
export function setupReplay(
  options: { specs?: RepositorySpec[]; config?: Record<string, unknown> } = {},
) {
  const sandbox = createSandbox()
  const replayConfig = config(options.config)
  sandbox.write(`work/replay/${replayConfig.name}.config.json`, JSON.stringify(replayConfig))
  const gitHub = createFakeGitHubReplay(
    buildWorld(options.specs ?? [{ name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 } }]),
  )
  return { sandbox, gitHub }
}

export function runReplay(argv: string[], sandbox: Sandbox, gitHub?: FakeGitHubReplay) {
  return runCli(['replay', ...argv], {
    sandbox,
    env: TOKEN,
    ...(gitHub ? { fetch: gitHub.handle } : {}),
  })
}

export { createSandbox, runCli }
