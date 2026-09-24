import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeJev } from './helpers/fake-jev.js'
import { runCli } from './helpers/run-cli.js'

interface SmokeExample {
  id: string
  expect: 'real' | 'noise'
  body: string
  hunk: string
}

const SET = JSON.parse(
  readFileSync(new URL('../src/smoke/smoke-set.json', import.meta.url), 'utf8'),
) as { version: string; bounds: Record<string, number>; examples: SmokeExample[] }

// A fake Jev that scores each smoke example by its expected class, except the overrides.
function jevFor(overrides: Record<string, number> = {}) {
  const byBody = new Map(SET.examples.map((example) => [example.body, example]))
  return createFakeJev({
    byComment: (comment) => {
      const example = byBody.get(comment)
      if (!example) return undefined
      return { act: overrides[example.id] ?? (example.expect === 'real' ? 0.92 : 0.08) }
    },
  })
}

function smoke(argv: string[], jev: ReturnType<typeof createFakeJev>) {
  return runCli(['smoke', ...argv], {
    env: { OPENROUTER_API_KEY: 'sk-or-smoke' },
    fetch: jev.handle,
  })
}

describe('smoke set (structure only; its answers are checked by hand with a real key)', () => {
  it('holds about 20 unmistakable examples, half real and half noise, with loose bounds', () => {
    expect(SET.examples.length).toBeGreaterThanOrEqual(18)
    expect(SET.examples.length).toBeLessThanOrEqual(22)
    const real = SET.examples.filter((example) => example.expect === 'real').length
    expect(real).toBe(SET.examples.length / 2)
    expect(new Set(SET.examples.map((example) => example.id)).size).toBe(SET.examples.length)
    expect(SET.bounds).toEqual({ real_at_least: 0.7, noise_below: 0.3 })
    for (const example of SET.examples) {
      expect(example.body.length).toBeGreaterThan(0)
      expect(example.hunk).toMatch(/^@@ /)
    }
  })
})

describe('smoke command', () => {
  it('passes when every example scores inside its bound, one request per example', async () => {
    const jev = jevFor()

    const result = await smoke([], jev)

    expect(result.exitCode).toBe(0)
    expect(jev.calls).toHaveLength(SET.examples.length)
    expect(result.stdout).toContain('smoke: pass\n')
    expect(result.stdout).toContain(`examples: ${SET.examples.length}\n`)
    expect(result.stdout).toContain('model: typesafe/jev-1.13-20260917\n')
    expect(result.stdout).not.toContain('outside_bounds')
  })

  it('fails and lists the examples outside their bounds', async () => {
    const jev = jevFor({ 'real-off-by-one': 0.55, 'noise-lgtm': 0.31 })

    const result = await smoke([], jev)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('smoke: fail\n')
    expect(result.stdout).toContain(
      'outside_bounds[2]{id,expected,worth,bound}:\n  real-off-by-one,real,0.55,>= 0.7\n  noise-lgtm,noise,0.31,< 0.3',
    )
  })

  it('stops at --max-cost with exit 3 and makes no paid call', async () => {
    const jev = jevFor()

    const result = await smoke(['--max-cost', '0'], jev)

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('smoke: stopped\n')
    expect(jev.calls).toHaveLength(0)
  })

  it('emits one JSON document with every example with --json', async () => {
    const result = await smoke(['--json'], jevFor())

    const document = JSON.parse(result.stdout)
    expect(document.smoke).toBe('pass')
    expect(document.examples).toHaveLength(SET.examples.length)
    expect(document.examples[0]).toEqual({
      id: SET.examples[0]?.id,
      expected: SET.examples[0]?.expect,
      worth: 0.92,
      bound: '>= 0.7',
      inside: true,
    })
  })
})

describe('automated checks', () => {
  it('never call Jev: CI runs only the offline checks and holds no provider key', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

    expect(workflow).not.toMatch(/OPENROUTER_API_KEY|TYPESAFE_API_KEY|secrets\./)
    expect(workflow).not.toMatch(/quiet-review-axi (score|replay|gate|smoke)/)
    expect(workflow.match(/- run: .+/g)).toEqual([
      '- run: npm ci',
      '- run: npm run lint',
      '- run: npm run format:check',
      '- run: npm run typecheck',
      '- run: npm test',
      '- run: npm run build',
    ])
  })
})
