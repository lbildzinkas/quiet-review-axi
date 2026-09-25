import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { Evaluation } from '../calibration/index.js'
import type { AppContext } from '../context.js'
import { BUILT_IN_PACK, CONTEXT_PACK } from '../core/questions.js'
import { BudgetStop, validationError } from '../errors.js'
import { loadUserConfig } from '../infra/config.js'
import { PROVIDERS } from '../jev/providers.js'
import { joinBlocks, renderHelp, resumeLimit, roundCost } from '../output/render.js'
import {
  evaluateVariant,
  labelledJudgeItems,
  scoreVariant,
  type AblationVariant,
  type VariantOutcome,
} from '../replay/ablation.js'
import type { DrawnItem } from '../replay/build.js'
import { defaultConfigPath, loadReplayConfig } from '../replay/config.js'
import { readFinalLabels } from '../replay/final-labels.js'
import { fromJsonl, readManifest, readOptional, replayDir, replayFiles } from '../replay/store.js'
import { BASELINE, defaultVariantsPath, loadVariants } from '../replay/variants.js'
import { jevJudgeOptions } from './jev-run.js'
import { DEFAULT_MAX_COST, parseNumber, parseProvider } from './score-args.js'

const ABLATE_FLAGS = {
  variants: { type: 'string' },
  config: { type: 'string' },
  dir: { type: 'string' },
  provider: { type: 'string' },
  'max-cost': { type: 'string' },
  'no-cache': { type: 'boolean' },
  json: { type: 'boolean' },
} as const

const NOTE =
  "exploratory: the ablation never changes the replay's verdict or cut-offs, and best_threshold is chosen on the same data it is measured on"

// The context ablation: scores an already-labelled replay's items under each context variant
// of a variants file, next to the baseline (the replay's own requests, so the cache serves
// them), and compares the variants' accuracy and token cost. It never touches the replay's
// stages, result or cut-offs.
export async function ablateCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  if (positionals.length > 1)
    throw validationError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`)
  const name = positionals[0] ?? 'default'
  const loaded = await loadReplayConfig(
    resolve(context.cwd, values.config ?? defaultConfigPath(context.cwd, name)),
    name,
  )
  const dir =
    values.dir === undefined ? replayDir(context.cwd, name) : resolve(context.cwd, values.dir)
  const manifest = await readManifest(dir, name)
  const itemsText = manifest.stages.label ? await readOptional(replayFiles(dir).items) : null
  const labels = manifest.stages.label ? await readFinalLabels(dir) : null
  if (itemsText === null || labels === null)
    throw validationError(`Replay ${name} has not been labelled yet`, [
      `Run \`quiet-review-axi replay ${name} --stage label\` first`,
    ])
  const variantsPath = resolve(
    context.cwd,
    values.variants ?? defaultVariantsPath(context.cwd, name),
  )
  const shownVariants = relative(context.cwd, variantsPath)
  const declared = await loadVariants(variantsPath, shownVariants)
  const variants: AblationVariant[] = [
    { name: BASELINE, pack: BUILT_IN_PACK, blocks: [] },
    ...declared.map((variant) => ({ ...variant, pack: CONTEXT_PACK })),
  ]
  const labelled = labelledJudgeItems(fromJsonl<DrawnItem>(itemsText), labels.labels)

  const userConfig = await loadUserConfig(context)
  const provider =
    PROVIDERS[
      parseProvider(values.provider) ??
        providerName(manifest.stages.score?.provider) ??
        userConfig.provider ??
        'openrouter'
    ]
  const maxCost = parseNumber('--max-cost', values['max-cost']) ?? DEFAULT_MAX_COST
  const asJson = values.json ?? false
  let spent = 0
  const outcomes: VariantOutcome[] = []
  for (const variant of variants) {
    context.stderr.write(`ablate: scoring variant ${variant.name}\n`)
    const judgeOptions = jevJudgeOptions({
      command: 'ablate',
      context,
      userConfig,
      provider,
      pack: variant.pack,
      // One --max-cost covers every variant of the ablation.
      flags: { maxCost: Math.max(0, maxCost - spent), noCache: values['no-cache'] ?? false },
    })
    const outcome = await scoreVariant({ variant, labelled, judgeOptions })
    spent += outcome.spentUsd
    outcomes.push(outcome)
    if (outcome.unscored > 0) break
  }

  const stopped = outcomes.find((outcome) => outcome.unscored > 0)
  if (stopped) {
    const view = {
      ablation: name,
      stopped: 'max-cost',
      code: 'BUDGET_STOP',
      scored:
        outcomes
          .filter((outcome) => outcome !== stopped)
          .map((outcome) => outcome.variant.name)
          .join(', ') || 'none',
      stopped_in: `${stopped.variant.name}: ${stopped.judgments.length} of ${labelled.length} items scored`,
      run_cost_usd: roundCost(spent),
    }
    const help = [
      `Run \`quiet-review-axi ablate ${name} --max-cost ${resumeLimit(maxCost)}\` to resume; results already paid for are cached and cost nothing`,
    ]
    throw new BudgetStop(render(view, help, asJson))
  }

  const evaluated = outcomes.map((outcome) => ({
    outcome,
    evaluation: evaluateVariant(outcome.judgments, loaded.config),
  }))
  const baseline = evaluated[0]
  const view: Record<string, unknown> = {
    ablation: name,
    variants_file: shownVariants,
    items: labelled.length,
    real: labelled.filter((entry) => entry.positive).length,
    noise: labelled.filter((entry) => !entry.positive).length,
    variants: evaluated.map(({ outcome, evaluation }) =>
      variantRow(outcome, evaluation, baseline?.evaluation ?? null),
    ),
    note: NOTE,
    cost_usd: roundCost(spent),
  }
  const help = [`Run \`quiet-review-axi ablate ${name} --json\` for every variant's full metrics`]
  return render(view, help, asJson)
}

function variantRow(outcome: VariantOutcome, evaluation: Evaluation, baseline: Evaluation | null) {
  const { threshold } = evaluation
  const items = outcome.judgments.length
  return {
    variant: outcome.variant.name,
    question_pack: outcome.variant.pack.version,
    blocks: outcome.variant.blocks.join('+') || 'none',
    items,
    auroc: rate(evaluation.auroc),
    auroc_ci95: range(evaluation.ranges.auroc),
    auroc_change:
      evaluation.auroc === null || baseline?.auroc === null || baseline === null
        ? 'n/a'
        : rate(evaluation.auroc - baseline.auroc),
    best_threshold: threshold?.threshold ?? 'none',
    noise_collapsed: rate(threshold?.negativesBelow ?? null),
    noise_collapsed_ci95: range(evaluation.ranges.negativesBelow),
    real_hidden: rate(threshold?.positivesBelow ?? null),
    input_tokens: outcome.inputTokens,
    tokens_per_item: items === 0 ? 0 : Math.round(outcome.inputTokens / items),
    cost_usd: roundCost(outcome.costUsd),
  }
}

function rate(value: number | null): number | string {
  return value === null ? 'n/a' : Number(value.toFixed(3))
}

function range(value: { low: number; high: number } | null): string {
  return value === null ? 'n/a' : `${rate(value.low)}-${rate(value.high)}`
}

function providerName(value: string | undefined): 'openrouter' | 'typesafe' | undefined {
  return value === 'openrouter' || value === 'typesafe' ? value : undefined
}

function render(view: Record<string, unknown>, help: string[], asJson: boolean): string {
  if (asJson) return JSON.stringify({ ...view, help }, null, 2)
  return joinBlocks(encode(view), renderHelp(help))
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: ABLATE_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi ablate --help` to see the flags',
    ])
  }
}

export const ABLATE_HELP = joinBlocks(
  encode({
    command: 'ablate',
    usage:
      'quiet-review-axi ablate [<replay>] [--variants <file>] [--config <file>] [--dir <path>] [--provider <openrouter|typesafe>] [--max-cost <usd>] [--no-cache] [--json]',
    description:
      "Context ablation: scores a labelled replay's items under each context variant of a variants file next to the baseline, and compares AUROC, noise collapsed and token cost (paid; never changes the replay's result)",
    flags: {
      '--variants <file>': 'Variants file (default: replay/<replay>.variants.json)',
      '--config <file>': 'Replay config (default: replay/<replay>.config.json)',
      '--dir <path>': 'Replay directory (default: .quiet-review/replays/<replay>)',
      '--provider <openrouter|typesafe>':
        'Jev backend (default: the one the replay was scored with)',
      '--max-cost <usd>':
        'Stop before a paid call would pass this total across every variant (default: 0.50; 0 = cache only)',
      '--no-cache': 'Skip cache reads and make fresh calls',
      '--json': 'Emit one JSON document',
    },
    exit_codes:
      '0 ok, 1 unexpected, 2 validation, 3 budget stop, 4 key, provider or GitHub problem',
  }),
  renderHelp([
    'Run `quiet-review-axi ablate public-v2` to compare the variants in replay/public-v2.variants.json',
  ]),
)
