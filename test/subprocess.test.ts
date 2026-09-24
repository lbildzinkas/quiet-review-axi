import { describe, expect, it } from 'vitest'
import { runSubprocess } from '../src/infra/subprocess.js'

// runSubprocess bounds every model-CLI call it runs (the label check's hang-proof timeout,
// spec 10.6): a child still running past its timeout is stopped and reported as a timeout.
describe('runSubprocess', () => {
  it('stops a child that runs past its timeout and reports the timeout', async () => {
    const outcome = await runSubprocess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      stdin: '',
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 100,
    })

    expect(outcome).toEqual({ kind: 'timeout' })
  })
})
