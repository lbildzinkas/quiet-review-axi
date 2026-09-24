import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { formatCutoff } from '../core/cutoffs.js'
import { validationError } from '../errors.js'
import { joinBlocks, renderHelp } from '../output/render.js'
import type { Interval, ReplayResult } from '../replay/evaluate.js'
import { readOptional, replayDir, replayFiles } from '../replay/store.js'

const REPORT_FLAGS = {
  dir: { type: 'string' },
  json: { type: 'boolean' },
} as const

const OPTIMISM_NOTE =
  'best_threshold is chosen on the same data it is measured on, so noise_collapsed and real_hidden are optimistic'

// The accuracy summary of an evaluated replay (spec 4.7). It reads result.json and calls no
// model. Every rate is printed with its 95% range.
export async function reportCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  if (positionals.length > 1)
    throw validationError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`)
  const result = await loadResult(context, positionals[0], values.dir)
  const view = summaryView(result)
  const help = [
    `Run \`quiet-review-axi report ${result.replay} --json\` for the full metrics, sweep and per-repo tables`,
  ]
  if (values.json)
    return JSON.stringify(
      {
        ...view,
        sweep: result.sweep,
        by_repository: result.by_repository,
        calibration: result.calibration,
        by_category: result.by_category,
        by_severity: result.by_severity,
        by_snapshot: result.by_snapshot,
        duplicate_rate: result.duplicate_rate,
        excluded_by_reason: result.excluded_by_reason,
        snapshots: result.snapshots,
        bootstrap: result.bootstrap,
        help,
      },
      null,
      2,
    )
  return joinBlocks(encode(view), renderHelp(help))
}

function summaryView(result: ReplayResult): Record<string, unknown> {
  const rule = result.pass_rule
  const view: Record<string, unknown> = {
    replay: result.replay,
    verdict: result.verdict,
  }
  if (result.refusal !== null) view.refusal = result.refusal
  Object.assign(view, {
    model: result.snapshots.join(', ') || 'none',
    question_pack: result.question_pack,
    items: result.items,
    real: result.real,
    noise: result.noise,
    auroc: rate(result.auroc),
    auroc_ci95: range(result.auroc_ci95),
    best_threshold: result.best_threshold ?? 'none',
    noise_collapsed: rate(result.noise_collapsed),
    noise_collapsed_ci95: range(result.noise_collapsed_ci95),
    real_hidden: rate(result.real_hidden),
    real_hidden_ci95: range(result.real_hidden_ci95),
    keep_precision: rate(result.keep_precision),
    keep_precision_ci95: range(result.keep_precision_ci95),
    pass_rule: `auroc >= ${formatCutoff(rule.min_auroc)} and exists t: noise_collapsed >= ${formatCutoff(rule.min_noise_collapsed)} and real_hidden <= ${formatCutoff(rule.max_real_hidden)} (judged on measured values)`,
    note: OPTIMISM_NOTE,
    label_check: 'not run: the check stage is not available in this version yet',
  })
  if (result.cutoffs_written !== undefined) view.cutoffs_written = result.cutoffs_written
  view.by_bot = result.by_bot.map((row) => ({
    bot: row.bot,
    items: row.items,
    real: row.real,
    auroc: rate(row.auroc),
  }))
  if (result.snapshots.length > 1)
    view.by_snapshot = result.by_snapshot.map((row) => ({
      snapshot: row.snapshot,
      items: row.items,
      real: row.real,
      auroc: rate(row.auroc),
    }))
  view.cost_usd = result.cost_usd
  return view
}

// Rates and AUROC to three decimals; the TOON encoder drops trailing zeros.
function rate(value: number | null): number | string {
  return value === null ? 'n/a' : Number(value.toFixed(3))
}

function range(value: Interval | null): string {
  if (value === null) return 'n/a'
  return `${rate(value[0])}-${rate(value[1])}`
}

async function loadResult(
  context: AppContext,
  name: string | undefined,
  dir: string | undefined,
): Promise<ReplayResult> {
  if (dir !== undefined || name !== undefined) {
    const target =
      dir === undefined ? replayDir(context.cwd, name ?? '') : resolve(context.cwd, dir)
    const text = await readOptional(replayFiles(target).result)
    if (text === null)
      throw validationError(`Replay ${name ?? dir} has not been evaluated yet`, [
        `Run \`quiet-review-axi replay ${name ?? '<name>'}\` to run its remaining stages`,
      ])
    return JSON.parse(text) as ReplayResult
  }
  const latest = await latestResult(replaysRoot(context.cwd))
  if (latest === null)
    throw validationError('No evaluated replay in .quiet-review/replays', [
      'Run `quiet-review-axi replay <name>` to build, score and evaluate a replay',
    ])
  return latest
}

export function replaysRoot(cwd: string): string {
  return join(cwd, '.quiet-review', 'replays')
}

// The most recently evaluated replay; replays evaluated at the same moment go by name.
export async function latestResult(root: string): Promise<ReplayResult | null> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return null
  }
  let latest: ReplayResult | null = null
  for (const name of names.sort()) {
    const text = await readOptional(replayFiles(join(root, name)).result)
    if (text === null) continue
    const result = JSON.parse(text) as ReplayResult
    if (latest === null || result.evaluated_at >= latest.evaluated_at) latest = result
  }
  return latest
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: REPORT_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi report --help` to see the flags',
    ])
  }
}

export const REPORT_HELP = joinBlocks(
  encode({
    command: 'report',
    usage: 'quiet-review-axi report [<name>] [--dir <path>] [--json]',
    description:
      'Prints the accuracy summary of an evaluated replay (default: the most recently evaluated one), with 95% ranges. Calls no model',
    flags: {
      '--dir <path>': 'Replay directory (default: .quiet-review/replays/<name>)',
      '--json':
        'Emit one JSON document, adding the threshold sweep, per-repository, calibration, category and severity tables',
    },
    exit_codes: '0 ok, 1 unexpected, 2 no evaluated replay',
  }),
  renderHelp(['Run `quiet-review-axi report public-v1` to see the result of replay public-v1']),
)
