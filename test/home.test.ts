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

  it('shows which file each cut-off comes from and warns when collapse is above the tested value', async () => {
    const sandbox = createSandbox()
    const repoPath = sandbox.write(
      'work/.quiet-review.json',
      JSON.stringify({ cutoffs: { collapse_below: 0.35 } }),
    )
    const userPath = sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({
        cutoffs: {
          collapse_below: 0.27,
          keep_at: 0.7,
          replay: 'public-v1',
          snapshot: 'typesafe/jev-1.13-20260917',
          tested_collapse_below: 0.27,
          written_at: '2026-10-01',
        },
      }),
      0o600,
    )

    const result = await runCli([], { sandbox })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'cutoffs: "collapse<0.35 keep>=0.70 (collapse: repo config, hand-set; keep: user config, calibrated on typesafe/jev-1.13-20260917 by replay public-v1)"',
    )
    expect(result.stdout).toContain(`repo_config: ${repoPath}`)
    expect(result.stdout).toContain(`user_config: ${userPath}`)
    expect(result.stdout).toContain(
      'collapse cut-off 0.35 is above the 0.27 the last replay tested, so more real issues than the replay measured may be collapsed',
    )
  })

  it('shows where the config files would go when none exist', async () => {
    const sandbox = createSandbox()

    const result = await runCli([], { sandbox })

    expect(result.stdout).toContain(`repo_config: none (${sandbox.cwd}/.quiet-review.json)`)
    expect(result.stdout).toContain(
      `user_config: none (${sandbox.env.XDG_CONFIG_HOME}/quiet-review-axi/config.json)`,
    )
    expect(result.stdout).not.toContain('warnings')
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
