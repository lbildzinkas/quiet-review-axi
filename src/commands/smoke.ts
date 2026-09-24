import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { cleanBody, hunkTail } from '../core/items.js'
import { BUILT_IN_PACK } from '../core/questions.js'
import { BudgetStop, validationError } from '../errors.js'
import { loadUserConfig } from '../infra/config.js'
import { createJevJudge, type JudgeItem } from '../jev/judge.js'
import { PROVIDERS } from '../jev/providers.js'
import { joinBlocks, renderHelp, resumeLimit, roundCost } from '../output/render.js'
import smokeSet from '../smoke/smoke-set.json' with { type: 'json' }
import { jevJudgeOptions } from './jev-run.js'
import { DEFAULT_MAX_COST, parseNumber, parseProvider } from './score-args.js'

interface SmokeExample {
  id: string
  expect: string
  title: string
  path: string
  lines: string
  hunk: string
  body: string
}

const SMOKE_FLAGS = {
  provider: { type: 'string' },
  'max-cost': { type: 'string' },
  'no-cache': { type: 'boolean' },
  json: { type: 'boolean' },
} as const

// The on-demand smoke set (spec 5.4.5): about 20 unmistakable comments, each scored in its
// own request with the built-in pack, checked against loose bounds (a clear problem scores
// at least 0.7, clear noise below 0.3). It needs a real key and is run by hand after a Jev
// model update or before a release, never in automated checks. A failed bound is data: the
// exit code stays 0.
export async function smokeCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  if (positionals.length > 0)
    throw validationError(`Unexpected arguments: ${positionals.join(' ')}`)
  const asJson = values.json ?? false
  const maxCost = parseNumber('--max-cost', values['max-cost']) ?? DEFAULT_MAX_COST
  const userConfig = await loadUserConfig(context)
  const provider = PROVIDERS[parseProvider(values.provider) ?? userConfig.provider ?? 'openrouter']
  const jev = createJevJudge(
    jevJudgeOptions({
      command: 'smoke',
      context,
      userConfig,
      provider,
      pack: BUILT_IN_PACK,
      flags: { maxCost, noCache: values['no-cache'] ?? false },
    }),
  )
  const examples = smokeSet.examples as SmokeExample[]
  const judgments = await jev.judge.judge(examples.map(judgeItem))
  const facts = jev.facts()
  const costUsd = roundCost(facts.costUsd)
  if (facts.unjudged.length > 0) {
    const view = {
      smoke: 'stopped',
      scored: `${judgments.length} of ${examples.length} examples`,
      cost_usd: costUsd,
    }
    const help = [
      `Run \`quiet-review-axi smoke --max-cost ${resumeLimit(maxCost)}\` to resume; results already paid for are cached and cost nothing`,
    ]
    throw new BudgetStop(render(view, help, asJson))
  }
  const worthOf = new Map(judgments.map((judgment) => [judgment.id, judgment.probability]))
  const { bounds } = smokeSet
  const rows = examples.map((example) => {
    const worth = worthOf.get(example.id) ?? 0
    const isReal = example.expect === 'real'
    return {
      id: example.id,
      expected: example.expect,
      worth: Number(worth.toFixed(3)),
      bound: isReal ? `>= ${bounds.real_at_least}` : `< ${bounds.noise_below}`,
      inside: isReal ? worth >= bounds.real_at_least : worth < bounds.noise_below,
    }
  })
  const outside = rows.filter((row) => !row.inside)
  const view: Record<string, unknown> = {
    smoke: outside.length === 0 ? 'pass' : 'fail',
    set: smokeSet.version,
    question_pack: BUILT_IN_PACK.version,
    provider: provider.name,
    model: facts.snapshots.join(', ') || 'none',
    examples: examples.length,
  }
  if (asJson) view.examples = rows
  else if (outside.length > 0)
    view.outside_bounds = outside.map(({ id, expected, worth, bound }) => ({
      id,
      expected,
      worth,
      bound,
    }))
  Object.assign(view, { calls: facts.calls, cost_usd: costUsd })
  const help =
    outside.length === 0
      ? ['Run `quiet-review-axi smoke --json` to see every example with its worth']
      : [
          'Run `quiet-review-axi replay <new-name>` to re-measure the cut-offs on this snapshot: a clear example outside its bound means the model behaves differently',
        ]
  return render(view, help, asJson)
}

function judgeItem(example: SmokeExample): JudgeItem {
  return {
    id: example.id,
    batch: example.id,
    header: { title: example.title },
    item: {
      key: 'c1',
      id: example.id,
      body: cleanBody(example.body),
      code: hunkTail(example.hunk),
      context: 'hunk',
      path: example.path,
      line: Number(example.lines.split('-').at(-1)),
      lines: example.lines,
      author: null,
      url: null,
    },
  }
}

function render(view: Record<string, unknown>, help: string[], asJson: boolean): string {
  if (asJson) return JSON.stringify({ ...view, help }, null, 2)
  return joinBlocks(encode(view), renderHelp(help))
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: SMOKE_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi smoke --help` to see the flags',
    ])
  }
}

export const SMOKE_HELP = joinBlocks(
  encode({
    command: 'smoke',
    usage:
      'quiet-review-axi smoke [--provider <openrouter|typesafe>] [--max-cost <usd>] [--no-cache] [--json]',
    description:
      'Scores the built-in smoke set of about 20 unmistakable review comments with Jev and checks loose bounds (a clear problem >= 0.7, clear noise < 0.3). Needs a real key; run it by hand after a Jev model update or before a release (paid, about $0.001)',
    flags: {
      '--provider <openrouter|typesafe>': 'Jev backend (default: openrouter, or the user config)',
      '--max-cost <usd>':
        'Stop before a paid call would pass this run total (default: 0.50; 0 = cache only)',
      '--no-cache': 'Skip cache reads and make fresh calls (use after a model update)',
      '--json': 'Emit one JSON document with every example',
    },
    exit_codes:
      '0 ok (examples outside their bounds are data, not an error), 1 unexpected, 2 validation, 3 budget stop, 4 key or provider problem',
  }),
  renderHelp(['Run `quiet-review-axi smoke --no-cache` after a Jev model update']),
)
