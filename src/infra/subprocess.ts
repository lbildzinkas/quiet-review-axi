import { spawn } from 'node:child_process'

export interface SubprocessOptions {
  command: string
  args: string[]
  // Written to the child's stdin, which is then closed.
  stdin?: string
  // The child's whole environment; `command` is looked up on its PATH.
  env: Record<string, string | undefined>
  cwd: string
  timeoutMs: number
}

export type SubprocessOutcome =
  | { kind: 'exited'; code: number | null; signal: string | null; stdout: string; stderr: string }
  | { kind: 'timeout' }
  | { kind: 'not-found' }

// After the timeout, the child gets SIGTERM, then SIGKILL if it is still running.
const KILL_GRACE_MS = 2_000

// Runs a command without a shell and collects its output. Used for model CLIs that reach a
// subscription (spec 10.6), so their credentials stay with the CLI.
export function runSubprocess(options: SubprocessOptions): Promise<SubprocessOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: definedOnly(options.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, options.timeoutMs)
    const settle = () => {
      clearTimeout(timer)
      clearTimeout(killer)
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle()
      if (error.code === 'ENOENT') resolve({ kind: 'not-found' })
      else reject(error)
    })
    child.on('close', (code, signal) => {
      settle()
      if (timedOut) resolve({ kind: 'timeout' })
      else resolve({ kind: 'exited', code, signal, stdout, stderr })
    })
    // A child that exits before reading its input closes the pipe; that is not an error here.
    child.stdin.on('error', () => {})
    child.stdin.end(options.stdin ?? '')
  })
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
