#!/usr/bin/env node
import { tryFastPath } from 'axi-sdk-js/fast-path'
import { VERSION } from '../src/version.js'

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { runFromProcess } = await import('../src/process.js')
  process.exitCode = await runFromProcess()
}
