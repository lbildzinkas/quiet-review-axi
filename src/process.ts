import { execFile } from 'node:child_process'
import { main } from './cli.js'

// Wires the real process, network and `gh` CLI into the injected context.
export async function runFromProcess(): Promise<number> {
  return main({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    fetch: (input, init) => fetch(input, init),
    readStdin,
    runGhAuthToken,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

// Runs `gh auth token` once, without a shell, with a 5 s timeout (spec 8.2).
function runGhAuthToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000, shell: false }, (error, stdout) => {
      const token = String(stdout ?? '').trim()
      resolve(error || token.length === 0 ? undefined : token)
    })
  })
}
