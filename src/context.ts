import type { FetchLike } from './jev/provider.js'

export interface Writable {
  write: (chunk: string) => unknown
}

// Everything that touches the outside world is injected, so tests can replace it (spec 11.2).
export interface AppContext {
  argv: string[]
  env: Record<string, string | undefined>
  cwd: string
  stdout: Writable
  stderr: Writable
  fetch: FetchLike
  readStdin: () => Promise<string>
  runGhAuthToken: () => Promise<string | undefined>
  sleep: (ms: number) => Promise<void>
  random: () => number
}
