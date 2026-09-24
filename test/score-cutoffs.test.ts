import { describe, expect, it } from 'vitest'
import { COMMENTS, JEV_ITEMS, PULL, REPOSITORY } from './fixtures/github/acme-widgets-412.js'
import { createFakeGitHub } from './helpers/fake-github.js'
import { createFakeJev } from './helpers/fake-jev.js'
import { combineHandlers, createSandbox, runCli, type Sandbox } from './helpers/run-cli.js'

const PR = 'acme/widgets#412'
const ENV = { OPENROUTER_API_KEY: 'sk-or-v1-secret-key', GITHUB_TOKEN: 'ghp_secret_token' }

function network() {
  const jev = createFakeJev({ items: JEV_ITEMS })
  const gitHub = createFakeGitHub({
    pulls: { [PR]: { repository: REPOSITORY, pull: PULL, comments: COMMENTS } },
  })
  const jevRoute = {
    matches: (url: string) => !url.startsWith('https://api.github.com/'),
    handle: jev.handle,
  }
  return { jev, fetch: combineHandlers(gitHub, jevRoute) }
}

async function score(args: string[], sandbox: Sandbox = createSandbox()) {
  const net = network()
  const result = await runCli(['score', PR, ...args], { sandbox, env: ENV, fetch: net.fetch })
  return { ...result, jev: net.jev }
}

describe('cut-offs in score output', () => {
  it('applies flag cut-offs for this run and labels them hand-set', async () => {
    const result = await score(['--collapse-below', '0.2', '--keep-at', '0.95'])

    expect(result.stdout).toContain('cutoffs: "collapse<0.20 keep>=0.95 (flag, hand-set)"')
    expect(result.stdout).toContain('verdicts: "keep 0, unsure 5, collapse 4"')
  })

  it('reads cut-offs from .quiet-review.json in the current directory', async () => {
    const sandbox = createSandbox()
    sandbox.write(
      'work/.quiet-review.json',
      JSON.stringify({ cutoffs: { collapse_below: 0.1, keep_at: 0.8 } }),
    )

    const result = await score([], sandbox)

    expect(result.stdout).toContain('cutoffs: "collapse<0.10 keep>=0.80 (repo config, hand-set)"')
    expect(result.stdout).toContain('verdicts: "keep 1, unsure 6, collapse 2"')
  })

  it('refuses a repository config that holds keys or privacy opt-ins, before any request', async () => {
    for (const field of ['keys', 'allow_private']) {
      const sandbox = createSandbox()
      sandbox.write(
        'work/.quiet-review.json',
        JSON.stringify({ [field]: field === 'keys' ? { openrouter: 'k' } : ['*'] }),
      )

      const result = await score([], sandbox)

      expect(result.exitCode, field).toBe(2)
      expect(result.stdout).toContain('code: VALIDATION_ERROR')
      expect(result.jev.calls).toEqual([])
    }
  })

  it('warns that calibrated cut-offs are stale when the model snapshot changed', async () => {
    const sandbox = createSandbox()
    sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({
        cutoffs: {
          collapse_below: 0.27,
          keep_at: 0.7,
          replay: 'public-v1',
          snapshot: 'typesafe/jev-1.13-20260801',
          tested_collapse_below: 0.27,
          written_at: '2026-08-05',
        },
      }),
      0o600,
    )

    const result = await score([], sandbox)

    expect(result.stdout).toContain(
      'cutoffs: "collapse<0.27 keep>=0.70 (user config, calibrated on typesafe/jev-1.13-20260801 by replay public-v1, stale)"',
    )
    expect(result.stdout).toContain(
      'calibrated cut-offs were measured on typesafe/jev-1.13-20260801, this run used typesafe/jev-1.13-20260917',
    )
    expect(result.stdout).toContain('Run `quiet-review-axi replay public-v1` again')
  })

  it('rejects cut-offs out of order, before any request', async () => {
    const result = await score(['--collapse-below', '0.8', '--keep-at', '0.5'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.jev.calls).toEqual([])
  })

  it('names each file when cut-offs from different sources combine out of order', async () => {
    const sandbox = createSandbox()
    const repoPath = sandbox.write(
      'work/.quiet-review.json',
      JSON.stringify({ cutoffs: { collapse_below: 0.8 } }),
    )
    const userPath = sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({ cutoffs: { keep_at: 0.6 } }),
      0o600,
    )

    const result = await score([], sandbox)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain(`collapse_below 0.8 (repo config ${repoPath})`)
    expect(result.stdout).toContain(`keep_at 0.6 (user config ${userPath})`)
    expect(result.jev.calls).toEqual([])
  })

  it('refuses a config file whose own cut-offs are out of order, even when a flag overrides one', async () => {
    const sandbox = createSandbox()
    const path = sandbox.write(
      'work/.quiet-review.json',
      JSON.stringify({ cutoffs: { collapse_below: 0.9, keep_at: 0.5 } }),
    )

    const result = await score(['--keep-at', '0.95'], sandbox)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain(path)
    expect(result.stdout).toContain('cutoffs.collapse_below 0.9 is above cutoffs.keep_at 0.5')
    expect(result.jev.calls).toEqual([])
  })

  it('refuses a misspelled cut-off key in the user config, naming the file and the key', async () => {
    const sandbox = createSandbox()
    const path = sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({ cutoffs: { collapse_below: 0.2, keep: 0.8 } }),
      0o600,
    )

    const result = await score([], sandbox)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
    expect(result.stdout).toContain(path)
    expect(result.stdout).toContain('cutoffs.keep')
    expect(result.jev.calls).toEqual([])
  })

  it('rejects unknown flags', async () => {
    const result = await score(['--bogus'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: VALIDATION_ERROR')
  })
})
