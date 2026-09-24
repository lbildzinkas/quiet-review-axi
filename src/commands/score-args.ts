import { parseArgs } from 'node:util'
import { validationError } from '../errors.js'
import type { ProviderName } from '../jev/provider.js'
import type { AuthorFilter } from '../inputs/pull-request.js'

export type OutputMode = 'toon' | 'json' | 'human'

export interface GlobalOptions {
  provider?: ProviderName
  maxCost: number
  noCache: boolean
  dryRun: boolean
  output: OutputMode
}

export interface ScoreOptions extends GlobalOptions {
  target?: string
  findings?: string
  repoRoot?: string
  all: boolean
  full: boolean
  authors: AuthorFilter
  collapseBelow?: number
  keepAt?: number
  allowPrivate: boolean
}

export const DEFAULT_MAX_COST = 0.5

const SCORE_FLAGS = {
  provider: { type: 'string' },
  'max-cost': { type: 'string' },
  'no-cache': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  human: { type: 'boolean' },
  findings: { type: 'string' },
  'repo-root': { type: 'string' },
  all: { type: 'boolean' },
  full: { type: 'boolean' },
  authors: { type: 'string' },
  'collapse-below': { type: 'string' },
  'keep-at': { type: 'string' },
  'allow-private': { type: 'boolean' },
} as const

export function parseScoreArgs(args: string[]): ScoreOptions {
  const { values, positionals } = parseFlags(args)
  if (values.json && values.human)
    throw validationError('--json and --human cannot be used together')
  if (positionals.length > 1)
    throw validationError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`)
  const target = positionals[0]
  if (target === undefined && values.findings === undefined)
    throw validationError('score needs a pull request URL or --findings <file>', [
      'Run `quiet-review-axi score <pr-url>` to score a pull request',
      'Run `quiet-review-axi score --findings <file>` to score a findings file',
    ])
  if (target !== undefined && values.findings !== undefined)
    throw validationError('Give either a pull request URL or --findings <file>, not both')
  return {
    provider: parseProvider(values.provider),
    maxCost: parseNumber('--max-cost', values['max-cost']) ?? DEFAULT_MAX_COST,
    noCache: values['no-cache'] ?? false,
    dryRun: values['dry-run'] ?? false,
    output: values.json ? 'json' : values.human ? 'human' : 'toon',
    target,
    findings: values.findings,
    repoRoot: values['repo-root'],
    all: values.all ?? false,
    full: values.full ?? false,
    authors: parseAuthors(values.authors),
    collapseBelow: parseNumber('--collapse-below', values['collapse-below']),
    keepAt: parseNumber('--keep-at', values['keep-at']),
    allowPrivate: values['allow-private'] ?? false,
  }
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: SCORE_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi score --help` to see the flags',
    ])
  }
}

function parseProvider(value: string | undefined): ProviderName | undefined {
  if (value === undefined || value === 'openrouter' || value === 'typesafe') return value
  throw validationError(`--provider must be openrouter or typesafe, not ${value}`)
}

function parseAuthors(value: string | undefined): AuthorFilter {
  if (value === undefined) return 'all'
  if (value === 'bots' || value === 'humans' || value === 'all') return value
  throw validationError(`--authors must be bots, humans or all, not ${value}`)
}

function parseNumber(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (value.trim() === '' || !Number.isFinite(number) || number < 0)
    throw validationError(`${flag} must be a non-negative number, not ${value}`)
  return number
}
