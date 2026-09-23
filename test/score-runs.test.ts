import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMENTS, JEV_ITEMS, PULL, REPOSITORY } from './fixtures/github/acme-widgets-412.js'
import { createFakeGitHub } from './helpers/fake-github.js'
import { createFakeJev, jsonResponse, type FakeJevOptions } from './helpers/fake-jev.js'
import { combineHandlers, createSandbox, runCli, type Sandbox } from './helpers/run-cli.js'

const PR = 'acme/widgets#412'
const KEY = { OPENROUTER_API_KEY: 'sk-or-v1-secret-key' }
const TOKEN = { GITHUB_TOKEN: 'ghp_secret_token' }

function network(options: { jev?: FakeJevOptions; comments?: unknown[] } = {}) {
  const jev = createFakeJev({ items: JEV_ITEMS, ...options.jev })
  const gitHub = createFakeGitHub({
    pulls: {
      [PR]: {
        repository: REPOSITORY,
        pull: PULL,
        comments: (options.comments ?? COMMENTS) as Record<string, unknown>[],
      },
    },
  })
  const jevRoute = {
    matches: (url: string) => !url.startsWith('https://api.github.com/'),
    handle: jev.handle,
  }
  return { jev, gitHub, fetch: combineHandlers(gitHub, jevRoute) }
}

function cacheFiles(sandbox: Sandbox): string[] {
  const dir = join(sandbox.env.XDG_CACHE_HOME, 'quiet-review-axi', 'jev')
  return existsSync(dir) ? readdirSync(dir) : []
}

function callLog(sandbox: Sandbox): Record<string, unknown>[] {
  const path = join(sandbox.env.XDG_STATE_HOME, 'quiet-review-axi', 'calls.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

// About 60 findings of 1,900 characters over three files: too big for one request.
function bigFindings(sandbox: Sandbox) {
  const findings = Array.from({ length: 60 }, (_, index) => ({
    id: `f-${index + 1}`,
    body: `Finding ${index + 1}: `.padEnd(1900, 'z'),
    path: `src/${'abc'[index % 3]}.ts`,
    line: index + 1,
    hunk: '+code',
  }))
  return sandbox.write('work/big.json', JSON.stringify({ findings }))
}

describe('request cache', () => {
  it('serves a repeated run from the cache: identical verdicts, no call, zero cost', async () => {
    const sandbox = createSandbox()
    const first = network()
    const second = network()

    const paid = await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: first.fetch,
    })
    const cached = await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: second.fetch,
    })

    expect(first.jev.calls).toHaveLength(1)
    expect(second.jev.calls).toHaveLength(0)
    expect(cached.exitCode).toBe(0)
    expect(cached.stdout).toContain('cost_usd: 0\n')
    expect(cached.stdout).toContain('cached: true\n')
    const verdictRows = (stdout: string) => stdout.slice(stdout.indexOf('keep['))
    expect(verdictRows(cached.stdout)).toBe(verdictRows(paid.stdout))
  })

  it('makes a fresh call with --no-cache and replaces the cached entry', async () => {
    const sandbox = createSandbox()
    await runCli(['score', PR], { sandbox, env: { ...KEY, ...TOKEN }, fetch: network().fetch })
    const fresh = network({
      jev: { items: { ...JEV_ITEMS, c1: { act: 0.5, cat: 'bug', sev: 3.2 } } },
    })

    const result = await runCli(['score', PR, '--no-cache'], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: fresh.fetch,
    })
    const reread = await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: network().fetch,
    })

    expect(fresh.jev.calls).toHaveLength(1)
    expect(result.stdout).toContain('cached: false')
    expect(reread.stdout).toContain('  c1,0.5,bug')
    expect(cacheFiles(sandbox)).toHaveLength(1)
  })

  it('never caches an invalid response', async () => {
    const sandbox = createSandbox()
    const broken = combineHandlers(network().gitHub, {
      matches: () => true,
      handle: async () =>
        jsonResponse(200, { model: 'm', answers: {}, usage: { input_tokens: 1 } }),
    })

    const result = await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: broken,
    })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: INVALID_RESPONSE')
    expect(cacheFiles(sandbox)).toEqual([])
  })
})

describe('determinism (R17)', () => {
  it('builds byte-identical request bodies and cache keys whatever the input order or cache state', async () => {
    const inOrder = network()
    const shuffled = network({ comments: [...COMMENTS].reverse() })
    const sandbox = createSandbox()

    const a = await runCli(['score', PR, '--json'], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: inOrder.fetch,
    })
    const b = await runCli(['score', PR, '--json', '--no-cache'], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: shuffled.fetch,
    })
    const warm = await runCli(['score', PR, '--json'], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: network().fetch,
    })

    expect(shuffled.jev.calls[0]?.body).toBe(inOrder.jev.calls[0]?.body)
    const keys = (stdout: string) => JSON.parse(stdout).run.cache_keys
    expect(keys(b.stdout)).toEqual(keys(a.stdout))
    expect(keys(warm.stdout)).toEqual(keys(a.stdout))
  })
})

describe('cost log', () => {
  it('appends one line per call, including cache hits, with no text, key or token', async () => {
    const sandbox = createSandbox()
    await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: network({ jev: { cost: () => 0.0002 } }).fetch,
    })
    await runCli(['score', PR], { sandbox, env: { ...KEY, ...TOKEN }, fetch: network().fetch })

    const lines = callLog(sandbox)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      command: 'score',
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
      snapshot: 'typesafe/jev-1.13-20260917',
      response_id: 'gen-dec-1',
      items: 9,
      cost_usd: 0.0002,
      cost_source: 'reported',
      cached: false,
      status: 'ok',
      question_pack: 'v0.1',
    })
    expect(lines[1]).toMatchObject({
      cached: true,
      cost_usd: 0,
      request_hash: lines[0]?.request_hash,
    })
    const raw = JSON.stringify(lines)
    expect(raw).not.toContain('Retry loop')
    expect(raw).not.toContain(KEY.OPENROUTER_API_KEY)
    expect(raw).not.toContain(TOKEN.GITHUB_TOKEN)
  })
})

describe('budget (--max-cost)', () => {
  it('stops before any call with --max-cost 0 and an empty cache, even without a key', async () => {
    const net = network()

    const result = await runCli(['score', PR, '--max-cost', '0'], { env: TOKEN, fetch: net.fetch })

    expect(result.exitCode).toBe(3)
    expect(net.jev.calls).toEqual([])
    expect(result.stdout).toContain('stopped: max-cost')
    expect(result.stdout).toContain('code: BUDGET_STOP')
  })

  it('stops before an over-budget call, prints what finished, and resumes paying only for the rest', async () => {
    const sandbox = createSandbox()
    const file = bigFindings(sandbox)
    const first = network()
    const second = network()

    const stopped = await runCli(['score', '--findings', file, '--max-cost', '0.0017'], {
      sandbox,
      env: KEY,
      fetch: first.fetch,
    })
    const resumed = await runCli(['score', '--findings', file, '--max-cost', '1'], {
      sandbox,
      env: KEY,
      fetch: second.fetch,
    })

    expect(stopped.exitCode).toBe(3)
    expect(first.jev.calls).toHaveLength(1)
    expect(stopped.stdout).toContain('stopped: max-cost')
    expect(stopped.stdout).toMatch(/unscored\[\d+\]/)
    expect(stopped.stdout).toContain('--max-cost')
    expect(resumed.exitCode).toBe(0)
    const calls = Number(resumed.stdout.match(/^calls: (\d+)$/m)?.[1])
    expect(calls).toBeGreaterThan(1)
    expect(second.jev.calls).toHaveLength(calls - 1)
    expect(resumed.stdout).not.toContain('unscored')
  })
})

describe('--dry-run', () => {
  it('builds and estimates the requests without calling Jev or needing a key', async () => {
    const net = network()

    const result = await runCli(['score', PR, '--dry-run'], { env: TOKEN, fetch: net.fetch })

    expect(result.exitCode).toBe(0)
    expect(net.jev.calls).toEqual([])
    expect(result.stdout).toContain('dry_run: true')
    expect(result.stdout).toMatch(
      /requests\[1\]\{call,items,estimated_tokens,cached\}:\n {2}1,9,\d+,false/,
    )
    expect(result.stdout).toMatch(/estimated_cost_usd: [\d.e-]+/)
  })
})

describe('provider keys', () => {
  it('fails with MISSING_KEY naming the variable for the chosen provider', async () => {
    const openrouter = await runCli(['score', PR], { env: TOKEN, fetch: network().fetch })
    const typesafe = await runCli(['score', PR, '--provider', 'typesafe'], {
      env: TOKEN,
      fetch: network().fetch,
    })

    expect(openrouter.exitCode).toBe(4)
    expect(openrouter.stdout).toContain('code: MISSING_KEY')
    expect(openrouter.stdout).toContain('OPENROUTER_API_KEY')
    expect(typesafe.stdout).toContain('TYPESAFE_API_KEY')
  })

  it('reads a key from the user config file when it is private to its owner', async () => {
    const sandbox = createSandbox()
    sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({ keys: { typesafe: 'ts-config-key' } }),
      0o600,
    )
    const net = network()

    const result = await runCli(['score', PR, '--provider', 'typesafe'], {
      sandbox,
      env: TOKEN,
      fetch: net.fetch,
    })

    expect(result.exitCode).toBe(0)
    expect(net.jev.calls[0]?.headers.authorization).toBe('Bearer ts-config-key')
    expect(net.jev.calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('refuses a config file holding keys that others can read', async () => {
    const sandbox = createSandbox()
    sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({ keys: { openrouter: 'sk-or-config' } }),
      0o644,
    )

    const result = await runCli(['score', PR], { sandbox, env: TOKEN, fetch: network().fetch })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: CONFIG_PERMISSIONS')
    expect(result.stdout).toContain('chmod 600')
    expect(result.stdout).not.toContain('sk-or-config')
  })

  it('uses the provider set in the user config unless --provider overrides it', async () => {
    const sandbox = createSandbox()
    sandbox.write(
      'config/quiet-review-axi/config.json',
      JSON.stringify({ provider: 'typesafe' }),
      0o600,
    )
    const fromConfig = network()
    const fromFlag = network()

    await runCli(['score', PR], {
      sandbox,
      env: { ...TOKEN, TYPESAFE_API_KEY: 'ts' },
      fetch: fromConfig.fetch,
    })
    await runCli(['score', PR, '--provider', 'openrouter'], {
      sandbox,
      env: { ...TOKEN, ...KEY },
      fetch: fromFlag.fetch,
    })

    expect(fromConfig.jev.calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(fromFlag.jev.calls[0]?.url).toBe('https://openrouter.ai/api/v1/systemone')
  })
})

describe('split pull requests', () => {
  it('reports the call count and marks exact-text duplicates across calls', async () => {
    const sandbox = createSandbox()
    const findings = Array.from({ length: 60 }, (_, index) => ({
      id: `f-${index + 1}`,
      body:
        index === 59 ? 'Finding 1: '.padEnd(1900, 'z') : `Finding ${index + 1}: `.padEnd(1900, 'z'),
      path: index === 59 ? 'src/z.ts' : `src/${'abc'[index % 3]}.ts`,
      line: index + 1,
      hunk: '+code',
    }))
    const file = sandbox.write('work/split.json', JSON.stringify({ findings }))
    const jev = createFakeJev()

    const result = await runCli(['score', '--findings', file, '--json'], {
      sandbox,
      env: KEY,
      fetch: jev.handle,
    })

    const document = JSON.parse(result.stdout)
    expect(document.calls).toBe(jev.calls.length)
    expect(document.calls).toBeGreaterThan(1)
    expect(document.items.find((item: { id: string }) => item.id === 'f-60').dup_of).toBe('f-1')
  })
})

describe('provider failures through the CLI', () => {
  it('exits 4 with the provider error code and caches nothing', async () => {
    const sandbox = createSandbox()
    const rejecting = combineHandlers(network().gitHub, {
      matches: () => true,
      handle: async () => jsonResponse(401, { error: { code: 401, message: 'User not found.' } }),
    })

    const result = await runCli(['score', PR], {
      sandbox,
      env: { ...KEY, ...TOKEN },
      fetch: rejecting,
    })

    expect(result.exitCode).toBe(4)
    expect(result.stdout).toContain('code: PROVIDER_AUTH')
    expect(result.stdout).toContain('OPENROUTER_API_KEY')
    expect(cacheFiles(sandbox)).toEqual([])
    expect(callLog(sandbox)[0]).toMatchObject({
      status: 'error',
      error_code: 'PROVIDER_AUTH',
      http_status: 401,
    })
  })
})
