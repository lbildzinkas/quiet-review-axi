import { beforeEach } from 'vitest'

// No test may reach the network: every test injects its own fake fetch into the CLI.
beforeEach(() => {
  globalThis.fetch = async (input: string | URL | Request) => {
    throw new Error(`Unexpected live network call in a test: ${String(input)}`)
  }
})
