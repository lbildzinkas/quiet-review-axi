import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { BUILT_IN_PACK, CONTEXT_PACK } from '../core/questions.js'
import { BudgetStop, validationError } from '../errors.js'
import { loadUserConfig } from '../infra/config.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import { PROVIDERS } from '../jev/providers.js'
import { joinBlocks, renderHelp, resumeLimit, roundCost } from '../output/render.js'
import {
  compareVariants,
  labelledJudgeItems,
  scoreVariant,
  withBlocks,
  type AblationResult,
  type AblationVariant,
  type VariantOutcome,
} from '../replay/ablation.js'
import type { DrawnItem } from '../replay/build.js'
import { defaultConfigPath, loadReplayConfig } from '../replay/config.js'
import { blockCoverage, gatherContext } from '../replay/context.js'
import { CONTEXT_BLOCKS } from '../replay/variants.js'
import { createReplayFetch } from '../replay/fetch.js'
import { readFinalLabels } from '../replay/final-labels.js'
import {
  ablationFiles,
  appendJsonl,
  fromJsonl,
  readManifest,
  readOptional,
  replayDir,
  replayFiles,
  toJsonl,
  writeAtomic,
} from '../replay/store.js'
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
  // The config's seed and pass-rule limits measure every variant, so it must be the one built.
  if (manifest.config_hash !== null && manifest.config_hash !== loaded.hash)
    throw validationError(
      `The replay config ${relative(context.cwd, loaded.path)} changed after build (recorded ${manifest.config_hash}, now ${loaded.hash})`,
      ['Restore the config as it was built before running the ablation'],
    )
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
  const drawn = fromJsonl<DrawnItem>(itemsText)
  const labelled = labelledJudgeItems(drawn, labels.labels)
  const blocks = new Set(variants.flatMap((variant) => variant.blocks))
  const replayContext =
    blocks.size === 0
      ? { pulls: new Map(), items: new Map() }
      : await gatherContext({
          client: await replayClient(context, dir),
          items: drawn.filter((item) => labelled.some((entry) => entry.item.id === item.id)),
          blocks,
          progress: (line) => context.stderr.write(`${line}\n`),
        })

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
    const outcome = await scoreVariant({
      variant,
      labelled: withBlocks(labelled, variant.blocks, replayContext),
      judgeOptions,
    })
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

  const result = compareVariants({
    replay: name,
    config: loaded.config,
    outcomes,
    provider: provider.name,
    variantsFile: shownVariants,
    trust: manifest.stages.check?.label_check?.trust ?? null,
    context: blockCoverage(
      replayContext,
      CONTEXT_BLOCKS.filter((block) => blocks.has(block)),
    ),
    costUsd: roundCost(spent),
    evaluatedAt: context.now().toISOString(),
  })
  const files = ablationFiles(dir)
  for (const outcome of outcomes)
    await writeAtomic(files.scores(outcome.variant.name), toJsonl(outcome.rows))
  await writeAtomic(files.result, `${JSON.stringify(result, null, 2)}\n`)
  await appendJsonl(replayFiles(dir).runs, {
    ts: result.evaluated_at,
    kind: 'ablation',
    replay: name,
    provider: provider.name,
    variants: result.variants.map((variant) => variant.variant),
    question_packs: [...new Set(result.variants.map((variant) => variant.question_pack))],
    snapshots: [...new Set(result.variants.flatMap((variant) => variant.snapshots))].sort(),
    auroc: Object.fromEntries(result.variants.map((variant) => [variant.variant, variant.auroc])),
    cost_usd: result.cost_usd,
  })
  const help = [
    `Run \`cat ${relative(context.cwd, files.result)}\` for every variant's full metrics, with keep precision and the real-hidden ranges`,
  ]
  return render(ablationView(result), help, asJson)
}

function ablationView(result: AblationResult): Record<string, unknown> {
  const view: Record<string, unknown> = {
    ablation: result.replay,
    variants_file: result.variants_file,
  }
  if (result.trust !== null) view.label_trust = result.trust
  Object.assign(view, { items: result.items, real: result.real, noise: result.noise })
  if (result.context.length > 0) view.context = result.context
  view.variants = result.variants.map((variant) => ({
    variant: variant.variant,
    question_pack: variant.question_pack,
    blocks: variant.blocks.join('+') || 'none',
    items: variant.items,
    auroc: rate(variant.auroc),
    auroc_ci95: range(variant.auroc_ci95),
    auroc_change: rate(variant.auroc_change),
    auroc_change_ci95: range(variant.auroc_change_ci95),
    best_threshold: variant.best_threshold ?? 'none',
    noise_collapsed: rate(variant.noise_collapsed),
    noise_collapsed_ci95: range(variant.noise_collapsed_ci95),
    real_hidden: rate(variant.real_hidden),
    input_tokens: variant.input_tokens,
    tokens_per_item: variant.tokens_per_item,
    cost_usd: roundCost(variant.cost_usd),
  }))
  view.by_bot = result.by_bot.map((row) => ({
    bot: row.bot,
    items: row.items,
    real: row.real,
    ...Object.fromEntries(
      Object.entries(row.auroc).map(([variant, auroc]) => [variant, rate(auroc)]),
    ),
  }))
  view.note = NOTE
  view.cost_usd = result.cost_usd
  return view
}

// The replay's read-only GitHub client, whose answers are cached in the replay directory, so a
// re-run reads nothing from the network.
async function replayClient(context: AppContext, dir: string) {
  const token = await requireGitHubToken(context.env, context.runGhAuthToken)
  return createGitHubClient({
    token: token.token,
    fetch: createReplayFetch({ ...context, cacheDir: replayFiles(dir).github }),
    callerPacesSearch: true,
  })
}

function rate(value: number | null): number | string {
  return value === null ? 'n/a' : Number(value.toFixed(3))
}

function range(value: [number, number] | null): string {
  return value === null ? 'n/a' : `${rate(value[0])}-${rate(value[1])}`
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
