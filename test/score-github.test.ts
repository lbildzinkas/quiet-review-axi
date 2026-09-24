import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createGitHubClient } from '../src/inputs/github.js'
import { COMMENTS, JEV_ITEMS, PULL, REPOSITORY } from './fixtures/github/acme-widgets-412.js'
import { createFakeGitHub, type FakeGitHubOptions } from './helpers/fake-github.js'
import { createFakeJev, jsonResponse } from './helpers/fake-jev.js'
import { combineHandlers, createSandbox, runCli, type FetchHandler } from './helpers/run-cli.js'

const PR = 'acme/widgets#412'
const KEY = { OPENROUTER_API_KEY: 'sk-or-v1-secret-key' }
const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }

function network(
  options: Partial<FakeGitHubOptions> & { isPrivate?: boolean; jev?: FetchHandler } = {},
) {
  const jev = createFakeJev({ items: JEV_ITEMS })
  const repository = options.isPrivate
    ? { ...REPOSITORY, private: true, visibility: 'private' }
    : REPOSITORY
  const gitHub = createFakeGitHub({
    pulls: { [PR]: { repository, pull: PULL, comments: COMMENTS } },
    ...options,
  })
  const jevRoute = {
    matches: (url: string) => !url.startsWith('https://api.github.com/'),
    handle: options.jev ?? jev.handle,
  }
  return { jev, gitHub, fetch: combineHandlers(gitHub, jevRoute) }
}

describe('GitHub token', () => {
  it('uses GITHUB_TOKEN first, then GH_TOKEN, then gh auth token', async () => {
    const both = network()
    const ghOnly = network()
    const cli = network()

    const first = await runCli(['score', PR], {
      env: { ...KEY, GITHUB_TOKEN: 'ghp_one', GH_TOKEN: 'ghp_two' },
      fetch: both.fetch,
      ghAuthToken: 'gho_three',
    })
    await runCli(['score', PR], {
      env: { ...KEY, GH_TOKEN: 'ghp_two' },
      fetch: ghOnly.fetch,
      ghAuthToken: 'gho_three',
    })
    await runCli(['score', PR], { env: KEY, fetch: cli.fetch, ghAuthToken: 'gho_three' })

    expect(both.gitHub.requests[0]?.authorization).toBe('token ghp_one')
    expect(first.ghCalls).toBe(0)
    expect(ghOnly.gitHub.requests[0]?.authorization).toBe('token ghp_two')
    expect(cli.gitHub.requests[0]?.authorization).toBe('token gho_three')
  })

  it('fails with MISSING_GITHUB_TOKEN explaining all three options when none is found', async () => {
    const result = await runCli(['score', PR], { env: KEY, fetch: network().fetch })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: MISSING_GITHUB_TOKEN')
    expect(result.stdout).toContain('GITHUB_TOKEN')
    expect(result.stdout).toContain('GH_TOKEN')
    expect(result.stdout).toContain('gh auth login')
  })
})

describe('GitHub errors', () => {
  it('maps a pull request that does not exist to GITHUB_NOT_FOUND', async () => {
    const result = await runCli(['score', 'acme/widgets#999'], {
      env: { ...KEY, ...TOKEN },
      fetch: network().fetch,
    })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: GITHUB_NOT_FOUND')
  })

  it('maps a rejected token to GITHUB_AUTH', async () => {
    const net = network({ status: { code: 401, body: { message: 'Bad credentials' } } })

    const result = await runCli(['score', PR], { env: { ...KEY, ...TOKEN }, fetch: net.fetch })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: GITHUB_AUTH')
  })

  it('maps an exhausted rate limit to GITHUB_RATE_LIMIT', async () => {
    const net = network({
      status: {
        code: 403,
        body: { message: 'API rate limit exceeded' },
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      },
    })

    const result = await runCli(['score', PR], { env: { ...KEY, ...TOKEN }, fetch: net.fetch })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: GITHUB_RATE_LIMIT')
  })

  it('reads every page of review comments', async () => {
    const result = await runCli(['score', PR], {
      env: { ...KEY, ...TOKEN },
      fetch: network({ pageSize: 4 }).fetch,
    })

    expect(result.stdout).toContain('verdicts: "keep 2, unsure 2, collapse 5"')
  })
})

describe('GitHub write protection', () => {
  it('refuses any REST request that is not a GET, before it is sent', async () => {
    const sent: string[] = []
    const client = createGitHubClient({
      token: 't',
      fetch: async (url) => (sent.push(url), jsonResponse(200, {})),
    })

    await expect(
      client.request('POST /repos/{owner}/{repo}/issues', { owner: 'a', repo: 'b', title: 'x' }),
    ).rejects.toThrow(/read-only/)
    await expect(
      client.request('PATCH /repos/{owner}/{repo}', { owner: 'a', repo: 'b' }),
    ).rejects.toThrow(/read-only/)
    expect(sent).toEqual([])
  })

  it('refuses GraphQL mutations, before they are sent', async () => {
    const sent: string[] = []
    const client = createGitHubClient({
      token: 't',
      fetch: async (url) => (sent.push(url), jsonResponse(200, { data: {} })),
    })

    await expect(
      client.graphql('mutation { minimizeComment(input: {}) { clientMutationId } }'),
    ).rejects.toThrow(/read-only/)
    expect(sent).toEqual([])
    await client.graphql('query { viewer { login } }')
    expect(sent).toEqual(['https://api.github.com/graphql'])
  })
})

describe('private repositories', () => {
  it('stops before any Jev call without an opt-in, naming the opt-in and the destination', async () => {
    const net = network({ isPrivate: true })

    const result = await runCli(['score', PR], { env: { ...KEY, ...TOKEN }, fetch: net.fetch })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('code: PRIVATE_REPO_NOT_ALLOWED')
    expect(result.stdout).toContain('--allow-private')
    expect(result.stdout).toContain('allow_private')
    expect(result.stdout).toContain('openrouter (typesafe/jev-1.13)')
    expect(net.jev.calls).toEqual([])
  })

  it('scores with --allow-private and prints and logs what was sent where', async () => {
    const sandbox = createSandbox()
    const net = network({ isPrivate: true })

    const result = await runCli(['score', PR, '--allow-private'], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: net.fetch,
    })

    const notice =
      'Sent comment text, code hunks and the PR title to openrouter (typesafe/jev-1.13); zero-data-retention routing was requested via provider preferences'
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`notice: "${notice}"`)
    const log = readFileSync(
      join(sandbox.env.XDG_STATE_HOME, 'quiet-review-axi', 'calls.jsonl'),
      'utf8',
    )
    expect(JSON.parse(log.trim()).notice).toBe(notice)
  })

  it('names the TypeSafe retention posture when TypeSafe is the provider', async () => {
    const result = await runCli(['score', PR, '--allow-private', '--provider', 'typesafe'], {
      env: { ...TOKEN, TYPESAFE_API_KEY: 'ts-key' },
      fetch: network({ isPrivate: true }).fetch,
    })

    expect(result.stdout).toContain(
      'to typesafe (jev-1.13.0); TypeSafe offers no per-request retention control, so retention follows TypeSafe terms',
    )
  })

  it('honours allow_private entries in the user config, including *', async () => {
    for (const entry of ['acme/widgets', '*']) {
      const sandbox = createSandbox()
      sandbox.write(
        'config/quiet-review-axi/config.json',
        JSON.stringify({ allow_private: [entry] }),
        0o600,
      )

      const result = await runCli(['score', PR], {
        sandbox,
        env: { ...KEY, ...TOKEN },
        fetch: network({ isPrivate: true }).fetch,
      })

      expect(result.exitCode, entry).toBe(0)
      expect(result.stdout).toContain('notice: "Sent comment text')
    }
  })

  it('says what would be sent, without claiming a send, under --dry-run', async () => {
    const result = await runCli(['score', PR, '--allow-private', '--dry-run'], {
      env: TOKEN,
      fetch: network({ isPrivate: true }).fetch,
    })

    expect(result.stdout).toContain(
      'notice: "Would send comment text, code hunks and the PR title to openrouter (typesafe/jev-1.13); nothing was sent"',
    )
  })

  it('prints no notice for a public repository', async () => {
    const result = await runCli(['score', PR], {
      env: { ...KEY, ...TOKEN },
      fetch: network().fetch,
    })

    expect(result.stdout).not.toContain('notice:')
  })
})

describe('redaction', () => {
  it('never writes a key or token to output or any file, even when a provider echoes them', async () => {
    const sandbox = createSandbox()
    const echo: FetchHandler = async () =>
      jsonResponse(422, {
        detail: `bad request from ${KEY.OPENROUTER_API_KEY} with ${TOKEN.GITHUB_TOKEN}`,
      })

    const result = await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: network({ jev: echo }).fetch,
    })

    expect(result.exitCode).toBe(4)
    const written = [
      result.stdout,
      result.stderr,
      ...sandbox.writtenFiles().map((file) => file.content),
    ].join('\n')
    expect(written).not.toContain(KEY.OPENROUTER_API_KEY)
    expect(written).not.toContain(TOKEN.GITHUB_TOKEN)
    const logPath = join(sandbox.env.XDG_STATE_HOME, 'quiet-review-axi', 'calls.jsonl')
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toContain('[REDACTED]')
  })
})
