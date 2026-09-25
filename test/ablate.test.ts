import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { combineHandlers, runCli, type Sandbox } from './helpers/run-cli.js'
import { JEV_KEY, runReplay, TOKEN, type FakeGitHubReplay, type FakeJev } from './helpers/replay.js'
import { jevByPart, scoredReplay, WORTH } from './helpers/scored-replay.js'

async function evaluatedReplay(setup = scoredReplay()) {
  await runReplay(['public-v1'], setup.sandbox, setup.gitHub, { jev: setup.jev })
  return setup
}

function writeVariants(sandbox: Sandbox, variants: unknown, name = 'public-v1') {
  sandbox.write(`work/replay/${name}.variants.json`, JSON.stringify(variants))
}

function ablate(argv: string[], sandbox: Sandbox, jev: FakeJev, gitHub?: FakeGitHubReplay) {
  return runCli(['ablate', ...argv], {
    sandbox,
    env: { ...TOKEN, ...JEV_KEY },
    fetch: combineHandlers(
      ...(gitHub ? [{ matches: gitHub.matches, handle: gitHub.handle }] : []),
      { matches: (url) => url.startsWith('https://openrouter.ai/'), handle: jev.handle },
    ),
  })
}

function replayFile(sandbox: Sandbox, name: string) {
  return readFileSync(join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', name), 'utf8')
}

describe('context ablation', () => {
  it("compares a variant with the baseline, served from the replay's own cached requests", async () => {
    const { sandbox } = await evaluatedReplay()
    writeVariants(sandbox, { variants: [{ name: 'wording', blocks: [] }] })
    const result = replayFile(sandbox, 'result.json')
    const manifest = replayFile(sandbox, 'manifest.json')
    // A second real comment now scores below a noise comment: AUROC 23/25 = 0.92.
    const jev = jevByPart({ ...WORTH, 3: 0.38 })

    const run = await ablate(['public-v1'], sandbox, jev)

    expect(run.exitCode).toBe(0)
    // The baseline's requests are byte-identical to the score stage's, so all come from the
    // cache; only the variant's ten requests reach Jev.
    expect(jev.calls).toHaveLength(10)
    expect(run.stdout).toContain('ablation: public-v1\n')
    expect(run.stdout).toMatch(/\n {2}baseline,v0\.1,none,10,0\.96,/)
    expect(run.stdout).toMatch(/\n {2}wording,v0\.1-context\.1,none,10,0\.92,/)
    expect(replayFile(sandbox, 'result.json')).toBe(result)
    expect(replayFile(sandbox, 'manifest.json')).toBe(manifest)
  })
})
