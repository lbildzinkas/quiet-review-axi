import { readFileSync } from 'node:fs'
import { buildWorld, config, type RepositorySpec } from '../fixtures/github/replay-world.js'
import { createFakeGitHubReplay } from './fake-github-replay.js'
import { createFakeJev } from './fake-jev.js'
import { createFakeLabelModel } from './fake-label-model.js'
import { combineHandlers, createSandbox, runCli, type RunOptions, type Sandbox } from './run-cli.js'

export const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }
// One OpenRouter key serves both Jev (score stage) and the label model (check stage).
export const JEV_KEY = { OPENROUTER_API_KEY: 'sk-or-replay-secret' }
export const LABEL_KEY = JEV_KEY

export type FakeGitHubReplay = ReturnType<typeof createFakeGitHubReplay>
export type FakeJev = ReturnType<typeof createFakeJev>
export type FakeLabelModel = ReturnType<typeof createFakeLabelModel>

export interface ReplayFakes extends Omit<RunOptions, 'sandbox' | 'fetch'> {
  jev?: FakeJev
  labelModel?: FakeLabelModel
}

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

// Runs `replay` with a GitHub token and an OpenRouter key. The network is the fake GitHub,
// a fake Jev (by default one that answers 0.5 for every item) and a fake label model (by
// default one that agrees with the main automatic rule); both fakes sit behind openrouter.ai.
export function runReplay(
  argv: string[],
  sandbox: Sandbox,
  gitHub?: FakeGitHubReplay,
  fakes: ReplayFakes = {},
) {
  const { jev = createFakeJev(), labelModel = createFakeLabelModel(), env, ...options } = fakes
  return runCli(['replay', ...argv], {
    ...options,
    sandbox,
    env: { ...TOKEN, ...JEV_KEY, ...env },
    fetch: combineHandlers(
      ...(gitHub ? [{ matches: gitHub.matches, handle: gitHub.handle }] : []),
      labelModel,
      { matches: (url) => url.startsWith('https://openrouter.ai/'), handle: jev.handle },
    ),
  })
}

export { createFakeJev, createSandbox, runCli }
