import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import { judgeLabelled, regressionGate, type GateResult } from '../calibration/index.js'
import type { AppContext } from '../context.js'
import { BUILT_IN_PACK, parseQuestionPack, type QuestionPack } from '../core/questions.js'
import { BudgetStop, validationError } from '../errors.js'
import { loadUserConfig } from '../infra/config.js'
import { createJevJudge } from '../jev/judge.js'
import { PROVIDERS } from '../jev/providers.js'
import { joinBlocks, renderHelp, resumeLimit, roundCost } from '../output/render.js'
import type { DrawnItem } from '../replay/build.js'
import type { ReplayResult } from '../replay/evaluate.js'
import { readFinalLabels } from '../replay/final-labels.js'
import { toJudgeItems } from '../replay/score.js'
import {
  appendJsonl,
  fromJsonl,
  readOptional,
  replayDir,
  replayFiles,
  writeAtomic,
} from '../replay/store.js'
import { jevJudgeOptions } from './jev-run.js'
import { DEFAULT_MAX_COST, parseNumber, parseProvider } from './score-args.js'

// A new pack may lose about this much AUROC against the replay it is gated on (spec 5.4.5).
export const MAX_AUROC_DROP = 0.02

const GATE_FLAGS = {
  pack: { type: 'string' },
  dir: { type: 'string' },
  provider: { type: 'string' },
  'max-cost': { type: 'string' },
  'no-cache': { type: 'boolean' },
  json: { type: 'boolean' },
} as const

// The question-pack regression gate (spec 5.4.5): re-scores an evaluated replay's labelled
// items with a candidate pack and accepts the pack only when AUROC drops by at most about
// 0.02 and the share of real issues hidden at the replay's calibrated threshold stays within
// the pass rule's limit. It never changes the replay's own result or the cut-offs.
export async function gateCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  if (positionals.length > 1)
    throw validationError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`)
  const name = positionals[0] ?? 'default'
  const dir =
    values.dir === undefined ? replayDir(context.cwd, name) : resolve(context.cwd, values.dir)
  const files = replayFiles(dir)
  const baselineText = await readOptional(files.result)
  const itemsText = await readOptional(files.items)
  const labels = await readFinalLabels(dir)
  if (baselineText === null || itemsText === null || labels === null)
    throw validationError(`Replay ${name} has not been evaluated yet`, [
      `Run \`quiet-review-axi replay ${name}\` to score and evaluate it with the current pack first`,
    ])
  const baseline = JSON.parse(baselineText) as ReplayResult
  const pack = values.pack === undefined ? BUILT_IN_PACK : await loadPack(context, values.pack)
  if (pack.version === baseline.question_pack)
    throw validationError(
      `The question pack ${pack.version} is the version replay ${name} was scored with; a changed pack needs a new version`,
      ['Run `quiet-review-axi gate <replay> --pack <file>` with a pack whose `version` is new'],
    )
  if (baseline.verdict === 'inconclusive')
    throw validationError(
      `Replay ${name} is inconclusive: its automatic labels are not trusted, so its metrics cannot judge a pack`,
      [
        `Run \`quiet-review-axi report ${name}\` to see the trust reasons`,
        'Revise the label rules and rerun the replay under a new name before gating a pack',
      ],
    )
  if (baseline.verdict === 'refused' || baseline.auroc === null || baseline.best_threshold === null)
    throw validationError(
      `Replay ${name} has no single-snapshot AUROC and best threshold to protect`,
      [`Run \`quiet-review-axi report ${name}\` to see why`],
    )

  const userConfig = await loadUserConfig(context)
  const provider =
    PROVIDERS[parseProvider(values.provider) ?? providerName(baseline.provider) ?? 'openrouter']
  const maxCost = parseNumber('--max-cost', values['max-cost']) ?? DEFAULT_MAX_COST
  const jev = createJevJudge(
    jevJudgeOptions({
      command: 'gate',
      context,
      userConfig,
      provider,
      pack,
      flags: { maxCost, noCache: values['no-cache'] ?? false },
    }),
  )
  const labelOf = new Map(labels.labels.map((entry) => [entry.id, entry.label]))
  const labelled = toJudgeItems(
    fromJsonl<DrawnItem>(itemsText).filter((item) => {
      const label = labelOf.get(item.id)
      return label === 'real' || label === 'noise'
    }),
  ).map((item) => ({ item, positive: labelOf.get(item.id) === 'real' }))
  const { judgments, missing } = await judgeLabelled(jev.judge, labelled, (item) => item.id)
  const facts = jev.facts()
  const costUsd = roundCost(facts.costUsd)
  const asJson = values.json ?? false

  if (missing.length > 0) {
    const view = {
      gate: 'stopped',
      replay: name,
      question_pack: pack.version,
      scored: `${judgments.length} of ${labelled.length} items`,
      cost_usd: costUsd,
    }
    const help = [
      `Run \`quiet-review-axi gate ${name}${values.pack === undefined ? '' : ` --pack ${values.pack}`} --max-cost ${resumeLimit(maxCost)}\` to resume; results already paid for are cached and cost nothing`,
    ]
    throw new BudgetStop(render(view, help, asJson))
  }

  const result = regressionGate(
    { auroc: baseline.auroc, threshold: baseline.best_threshold },
    judgments,
    { maxAurocDrop: MAX_AUROC_DROP, maxPositivesBelow: baseline.pass_rule.max_real_hidden },
  )
  const decision = result.refusal !== null ? 'refused' : result.accepted ? 'accepted' : 'rejected'
  const view: Record<string, unknown> = {
    gate: decision,
    replay: name,
    question_pack: pack.version,
    baseline_pack: baseline.question_pack,
    model: facts.snapshots.join(', ') || 'none',
    baseline_model: baseline.snapshots.join(', '),
    auroc: rounded(result.auroc),
    baseline_auroc: rounded(baseline.auroc),
    auroc_drop: rounded(result.aurocDrop),
    threshold: baseline.best_threshold,
    real_hidden: rounded(result.positivesBelow),
    rule: `auroc drops by at most ${MAX_AUROC_DROP} and real_hidden at the baseline threshold stays <= ${baseline.pass_rule.max_real_hidden}`,
  }
  const reasons = gateReasons(result, baseline)
  if (reasons.length > 0) view.reasons = reasons
  const warning = snapshotWarning(facts.snapshots, baseline.snapshots)
  if (warning !== null) view.warning = warning
  Object.assign(view, { items: judgments.length, calls: facts.calls, cost_usd: costUsd })

  const now = context.now().toISOString()
  const record = {
    ts: now,
    kind: 'gate',
    replay: name,
    question_pack: pack.version,
    baseline_pack: baseline.question_pack,
    provider: provider.name,
    snapshots: facts.snapshots,
    baseline_snapshots: baseline.snapshots,
    decision,
    items: judgments.length,
    auroc: view.auroc,
    baseline_auroc: view.baseline_auroc,
    auroc_drop: view.auroc_drop,
    threshold: baseline.best_threshold,
    real_hidden: view.real_hidden,
  }
  await writeAtomic(
    replayFiles(dir).gate(pack.version),
    `${JSON.stringify({ ...record, reasons, warning }, null, 2)}\n`,
  )
  await appendJsonl(files.runs, record)
  const help =
    decision === 'accepted'
      ? [
          values.pack === undefined
            ? `Run \`cat ${relative(context.cwd, files.runs)}\` to see every gate run, and record this one in replay/${name}.result.md`
            : `Run \`cp ${values.pack} src/core/question-pack.json\` to adopt pack ${pack.version}, and record this gate run in replay/${name}.result.md`,
        ]
      : [
          `Run \`quiet-review-axi gate ${name} --pack <file>\` to gate a reworked pack; keep pack ${baseline.question_pack} until one is accepted`,
        ]
  return render(view, help, asJson)
}

function gateReasons(result: GateResult, baseline: ReplayResult): string[] {
  if (result.refusal === 'mixed snapshots')
    return ['the candidate was scored on more than one snapshot; re-run on one']
  if (result.refusal === 'one class') return ['the replay needs both real and noise items']
  const reasons: string[] = []
  if (!result.checks.auroc)
    reasons.push(`auroc dropped by ${rounded(result.aurocDrop)}, more than ${MAX_AUROC_DROP}`)
  if (!result.checks.positivesBelow)
    reasons.push(
      `real_hidden at the baseline threshold ${baseline.best_threshold} is ${rounded(result.positivesBelow)}, above ${baseline.pass_rule.max_real_hidden}`,
    )
  return reasons
}

function snapshotWarning(candidate: string[], baseline: string[]): string | null {
  if (candidate.length === 0 || candidate.join(',') === baseline.join(',')) return null
  return `the candidate was scored on ${candidate.join(', ')} and the baseline on ${baseline.join(', ')}, so a model change is mixed with the wording change`
}

function rounded(value: number | null): number | string {
  return value === null ? 'n/a' : Number(value.toFixed(3))
}

function providerName(value: string): 'openrouter' | 'typesafe' | undefined {
  return value === 'openrouter' || value === 'typesafe' ? value : undefined
}

function render(view: Record<string, unknown>, help: string[], asJson: boolean): string {
  if (asJson) return JSON.stringify({ ...view, help }, null, 2)
  return joinBlocks(encode(view), renderHelp(help))
}

async function loadPack(context: AppContext, file: string): Promise<QuestionPack> {
  let text: string
  try {
    text = await readFile(resolve(context.cwd, file), 'utf8')
  } catch {
    throw validationError(`Cannot read the question pack ${file}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw validationError(`Invalid question pack ${file}: not valid JSON`)
  }
  return parseQuestionPack(raw, file)
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: GATE_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi gate --help` to see the flags',
    ])
  }
}

export const GATE_HELP = joinBlocks(
  encode({
    command: 'gate',
    usage:
      'quiet-review-axi gate [<replay>] [--pack <file>] [--dir <path>] [--provider <openrouter|typesafe>] [--max-cost <usd>]',
    description:
      "Question-pack regression gate: re-scores an evaluated replay's labelled items with a new pack and accepts it only if AUROC drops by at most 0.02 and real issues hidden at the calibrated threshold stay within the pass rule's limit (paid)",
    flags: {
      '--pack <file>': 'Candidate question pack (default: the pack built into this version)',
      '--dir <path>': 'Replay directory (default: .quiet-review/replays/<replay>)',
      '--provider <openrouter|typesafe>':
        'Jev backend (default: the one the replay was scored with)',
      '--max-cost <usd>':
        'Stop before a paid call would pass this run total (default: 0.50; 0 = cache only)',
      '--no-cache': 'Skip cache reads and make fresh calls',
      '--json': 'Emit one JSON document',
    },
    exit_codes:
      '0 ok (a rejected pack is data, not an error), 1 unexpected, 2 validation, 3 budget stop, 4 key or provider problem',
  }),
  renderHelp([
    'Run `quiet-review-axi gate public-v1 --pack packs/v0.2.json` to gate a reworded pack against replay public-v1',
  ]),
)
