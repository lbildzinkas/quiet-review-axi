import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sandbox } from './run-cli.js'

export const PI_MODEL = 'zai-coding-cn/glm-5.3'
export const PI_VERSION = '0.86.1'

// What the fake `pi` does for one comment: a bare label becomes the JSON answer the prompt asks
// for and other text is the answer verbatim; the object forms fail the call in one way each.
export type PiScript =
  | string
  | { exit: number; stderr?: string }
  | { stopReason: 'error' | 'aborted'; errorMessage: string }
  | { noAnswer: true }

export interface FakePiOptions {
  // Per pull request of the replay world; other comments are answered like the main
  // automatic rule (`real` when the evidence shows a change at the commented lines).
  byPr?: Record<number, PiScript>
  // The answering model the fake reports; default the configured model's id.
  snapshot?: string
  version?: string
}

export interface PiCall {
  args: string[]
  stdin: string
  cwd: string
}

// A stand-in for the Pi coding agent CLI: an executable named `pi` in the sandbox, found on
// PATH, that answers `--version` and print-mode JSON runs from a script and records every run.
// It makes no network call; the real `pi` is never on the tests' PATH.
export function createFakePi(sandbox: Sandbox, options: FakePiOptions = {}) {
  const dir = join(sandbox.root, 'fake-pi')
  const callsPath = join(dir, 'calls.jsonl')
  const scriptPath = sandbox.write('fake-pi/script.json', JSON.stringify(options))
  const executable = sandbox.write('fake-pi/bin/pi', program(scriptPath, callsPath))
  chmodSync(executable, 0o755)
  return {
    env: { PATH: join(dir, 'bin') },
    calls(): PiCall[] {
      if (!existsSync(callsPath)) return []
      return readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PiCall)
    },
    // Replaces the script for later runs, as a changed subscription answer would.
    rescript(next: FakePiOptions) {
      writeFileSync(scriptPath, JSON.stringify(next))
    },
  }
}

export type FakePi = ReturnType<typeof createFakePi>

function program(scriptPath: string, callsPath: string): string {
  return `#!${process.execPath}
const fs = require('node:fs')
const script = JSON.parse(fs.readFileSync(${JSON.stringify(scriptPath)}, 'utf8'))
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write((script.version ?? ${JSON.stringify(PI_VERSION)}) + '\\n')
  process.exit(0)
}
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (stdin += chunk))
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\\n')
  const commentId = Number((stdin.match(/\\(#(\\d+)\\)/) || [])[1] || 0)
  const pr = Math.floor((commentId % 1000000) / 1000)
  const scripted = (script.byPr || {})[pr] ??
    (/"changes_after_comment": "@@/.test(stdin) ? 'real' : 'noise')
  answer(scripted)
})

function answer(scripted) {
  if (typeof scripted === 'object' && 'exit' in scripted) {
    process.stderr.write(scripted.stderr ?? '')
    process.exit(scripted.exit)
  }
  const model = script.snapshot ?? args[args.indexOf('--model') + 1].split('/').pop()
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
  emit({ type: 'session', version: 3, id: 'fake-session', cwd: process.cwd() })
  emit({ type: 'agent_start' })
  emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: stdin }] } })
  if (typeof scripted === 'object' && scripted.noAnswer) {
    emit({ type: 'agent_end', messages: [] })
    return
  }
  const failed = typeof scripted === 'object' && 'stopReason' in scripted
  const text = failed ? '' : ['real', 'noise', 'unsure'].includes(scripted)
    ? JSON.stringify({ label: scripted, reason: 'The evidence says ' + scripted + '.' })
    : scripted
  const message = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Weighing the evidence.' },
      ...(failed ? [] : [{ type: 'text', text }]),
    ],
    api: 'openai-completions',
    provider: 'zai-coding-cn',
    model,
    responseId: 'fake-response-' + (stdin.length % 997),
    usage: { input: 900, output: 40, cacheRead: 100, cacheWrite: 0, reasoning: 12, totalTokens: 1040,
      cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } },
    stopReason: failed ? scripted.stopReason : 'stop',
    ...(failed ? { errorMessage: scripted.errorMessage } : {}),
  }
  emit({ type: 'message_end', message })
  emit({ type: 'agent_end', messages: [message] })
}
`
}
