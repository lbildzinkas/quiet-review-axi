import { parseArgs } from 'node:util'
import { validationError } from '../errors.js'

export interface ScoreOptions {
  findings: string
}

export function parseScoreArgs(args: string[]): ScoreOptions {
  const { values } = parseArgs({
    args,
    options: { findings: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  if (values.findings === undefined)
    throw validationError('score needs a pull request URL or --findings <file>')
  return { findings: values.findings }
}
