import { readFileSync } from 'node:fs'
import { buildWorld, config, type RepositorySpec } from '../fixtures/github/replay-world.js'
import { createFakeGitHubReplay } from './fake-github-replay.js'
import { createFakeLabelModel } from './fake-label-model.js'
import { combineHandlers, createSandbox, runCli, type RunOptions, type Sandbox } from './run-cli.js'

export const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }
export const LABEL_KEY = { OPENROUTER_API_KEY: 'sk-or-secret-label-key' }

export type FakeGitHubReplay = ReturnType<typeof createFakeGitHubReplay>
export type FakeLabelModel = ReturnType<typeof createFakeLabelModel>

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

// Runs `replay` with a GitHub token and an OpenRouter key; the network is the fake GitHub
// plus a label model (by default one that labels every comment `real`).
export function runReplay(
  argv: string[],
  sandbox: Sandbox,
  gitHub?: FakeGitHubReplay,
  labelModel: FakeLabelModel = createFakeLabelModel(),
  options: Omit<RunOptions, 'sandbox' | 'fetch'> = {},
) {
  return runCli(['replay', ...argv], {
    ...options,
    sandbox,
    env: { ...TOKEN, ...LABEL_KEY, ...options.env },
    ...(gitHub ? { fetch: combineHandlers(gitHub, labelModel) } : {}),
  })
}

export { createSandbox, runCli }
