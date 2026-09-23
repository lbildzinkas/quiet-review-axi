import { describe, expect, it } from 'vitest'
import { createFakeJev } from './helpers/fake-jev.js'
import { createSandbox, runCli } from './helpers/run-cli.js'

describe('home view', () => {
  it('shows where the key and token come from, never their values', async () => {
    const result = await runCli([], {
      env: { OPENROUTER_API_KEY: 'sk-or-v1-home-key', GITHUB_TOKEN: 'ghp_home_token' },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('provider: openrouter\nmodel: typesafe/jev-1.13\n')
    expect(result.stdout).toContain('key: set (env OPENROUTER_API_KEY)')
    expect(result.stdout).toContain('github_token: set (env GITHUB_TOKEN)')
    expect(result.stdout).toContain('cutoffs: "collapse<0.30 keep>=0.70 (built-in, uncalibrated)"')
    expect(result.stdout).toContain('cache: 0 entries')
    expect(result.stdout).toContain('spent_today_usd: 0')
    expect(result.stdout).toContain('Run `quiet-review-axi score <pr-url>`')
    expect(result.stdout).not.toContain('sk-or-v1-home-key')
    expect(result.stdout).not.toContain('ghp_home_token')
  })

  it('reports missing credentials, and a key and provider from the user config', async () => {
    const missing = await runCli([])
    const sandbox = createSandbox()
    sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({ provider: 'typesafe', keys: { typesafe: 'ts-key' } }),
      0o600,
    )
    const configured = await runCli([], { sandbox, ghAuthToken: 'gho_cli' })

    expect(missing.stdout).toContain('key: missing')
    expect(missing.stdout).toContain('github_token: missing')
    expect(configured.stdout).toContain('provider: typesafe\nmodel: jev-1.13.0\n')
    expect(configured.stdout).toContain('key: set (config file)')
    expect(configured.stdout).toContain('github_token: set (gh auth token)')
  })

  it('counts cache entries and sums today’s spend from the cost log', async () => {
    const sandbox = createSandbox()
    const file = sandbox.write(
      'work/f.json',
      JSON.stringify({ findings: [{ id: 'a', body: 'x', hunk: '+y' }] }),
    )
    const jev = createFakeJev({ cost: () => 0.0031 })
    await runCli(['score', '--findings', file], {
      sandbox,
      env: { OPENROUTER_API_KEY: 'k' },
      fetch: jev.handle,
    })

    const result = await runCli([], { sandbox })

    expect(result.stdout).toContain('cache: 1 entries')
    expect(result.stdout).toContain('spent_today_usd: 0.0031')
  })
})

describe('update', () => {
  it('prints the repository install command instead of installing from npm, which v0 does not publish to', async () => {
    const result = await runCli(['update'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('npm install -g github:lbildzinkas/quiet-review-axi')
    expect(result.fetchCalls).toEqual([])
  })
})
