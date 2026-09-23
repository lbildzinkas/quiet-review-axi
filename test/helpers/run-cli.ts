import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { main } from '../../src/cli.js'

export type FetchHandler = (url: string, init: RequestInit) => Promise<Response>

export interface Sandbox {
  root: string
  cwd: string
  env: Record<string, string>
  write: (relativePath: string, content: string, mode?: number) => string
  writtenFiles: () => { path: string; content: string }[]
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'qra-test-'))
  const cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  const env = {
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    HOME: join(root, 'home'),
  }
  return {
    root,
    cwd,
    env,
    write(relativePath, content, mode) {
      const path = join(root, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, mode === undefined ? undefined : { mode })
      return path
    },
    writtenFiles: () => listFiles(root),
  }
}

function listFiles(dir: string): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listFiles(path)
    return [{ path, content: readFileSync(path, 'utf8') }]
  })
}

export interface RunOptions {
  sandbox?: Sandbox
  env?: Record<string, string>
  fetch?: FetchHandler
  stdin?: string
  ghAuthToken?: string
  sleep?: (ms: number) => Promise<void>
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  sandbox: Sandbox
  fetchCalls: { url: string; init: RequestInit }[]
  ghCalls: number
}

export async function runCli(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const sandbox = options.sandbox ?? createSandbox()
  let stdout = ''
  let stderr = ''
  let ghCalls = 0
  const fetchCalls: { url: string; init: RequestInit }[] = []
  const handler = options.fetch
  const exitCode = await main({
    argv,
    env: { ...sandbox.env, ...options.env },
    cwd: sandbox.cwd,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : String(input)
      const request = input instanceof Request ? requestInit(input, init) : init
      fetchCalls.push({ url, init: await request })
      if (!handler) throw new Error(`No fake network configured for ${url}`)
      return handler(url, await request)
    },
    readStdin: async () => options.stdin ?? '',
    runGhAuthToken: async () => {
      ghCalls++
      return options.ghAuthToken
    },
    sleep: options.sleep ?? (async () => {}),
    random: () => 0.5,
  })
  return { stdout, stderr, exitCode, sandbox, fetchCalls, ghCalls }
}

async function requestInit(request: Request, init: RequestInit): Promise<RequestInit> {
  const body = request.method === 'GET' ? undefined : await request.text()
  return { ...init, method: request.method, headers: request.headers, body }
}

export function combineHandlers(
  ...handlers: { matches: (url: string) => boolean; handle: FetchHandler }[]
): FetchHandler {
  return async (url, init) => {
    const handler = handlers.find((candidate) => candidate.matches(url))
    if (!handler) throw new Error(`No fake network route for ${url}`)
    return handler.handle(url, init)
  }
}
