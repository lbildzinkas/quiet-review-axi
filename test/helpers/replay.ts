import { readFileSync } from 'node:fs'
import { buildWorld, config, type RepositorySpec } from '../fixtures/github/replay-world.js'
import { createFakeGitHubReplay } from './fake-github-replay.js'
import { createFakeJev } from './fake-jev.js'
import { combineHandlers, createSandbox, runCli, type Sandbox } from './run-cli.js'

export const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }
export const JEV_KEY = { OPENROUTER_API_KEY: 'sk-or-replay-secret' }

export type FakeGitHubReplay = ReturnType<typeof createFakeGitHubReplay>
export type FakeJev = ReturnType<typeof createFakeJev>

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

// Runs `replay` with a GitHub token and a Jev key. GitHub requests go to the fake GitHub;
// Jev requests go to `jev` (by default a fake that answers 0.5 for every item).
export function runReplay(
  argv: string[],
  sandbox: Sandbox,
  gitHub?: FakeGitHubReplay,
  jev: FakeJev = createFakeJev(),
  now?: Date,
) {
  return runCli(['replay', ...argv], {
    sandbox,
    now,
    env: { ...TOKEN, ...JEV_KEY },
    fetch: combineHandlers(
      ...(gitHub ? [{ matches: gitHub.matches, handle: gitHub.handle }] : []),
      { matches: (url) => url.startsWith('https://openrouter.ai/'), handle: jev.handle },
    ),
  })
}

export { createFakeJev, createSandbox, runCli }
