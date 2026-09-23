import { describe, expect, it } from 'vitest'
import { createFakeJev } from './helpers/fake-jev.js'
import { createSandbox, runCli } from './helpers/run-cli.js'

const KEY_ENV = { OPENROUTER_API_KEY: 'sk-or-test-key' }

function findingsFile(findings: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ title: 'Add retry to webhook sender', findings, ...extra })
}

describe('score --findings', () => {
  it('scores a findings file and prints a keep row with its text', async () => {
    const sandbox = createSandbox()
    const file = sandbox.write(
      'work/findings.json',
      findingsFile([
        {
          id: 'f-12',
          body: 'Retry loop never resets `attempt`, so after the first failure every later send gives up immediately.',
          path: 'src/webhook.ts',
          line: 88,
          hunk: '  for (;;) {\n    attempt++',
          author: 'reviewer-bot',
        },
      ]),
    )
    const jev = createFakeJev({ items: { c1: { act: 0.91, cat: 'bug', sev: 3.2 } } })

    const result = await runCli(['score', '--findings', file], {
      sandbox,
      env: KEY_ENV,
      fetch: jev.handle,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('verdicts: "keep 1, unsure 0, collapse 0"')
    expect(result.stdout).toContain('keep[1]{id,worth,category,severity,author,path,line,text}:')
    expect(result.stdout).toContain(
      '  f-12,0.91,bug,3.2,reviewer-bot,src/webhook.ts,88,"Retry loop never resets `attempt`, so after the first failure every later send gives up immediately."',
    )
  })
})
