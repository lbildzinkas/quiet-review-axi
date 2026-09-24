import { randomBytes } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { BudgetStop, validationError } from '../errors.js'
import { createBudget, type Budget } from '../infra/budget.js'
import { canonicalJson } from '../infra/canonical-json.js'
import { findApiKey, loadUserConfig, missingKeyError, secretsOf } from '../infra/config.js'
import { callLogPath, labelCacheDir } from '../infra/paths.js'
import { createRedactor } from '../infra/redact.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import { openRouterProvider } from '../jev/openrouter.js'
import { joinBlocks, renderHelp, roundCost } from '../output/render.js'
import { MAX_REPOSITORIES, MIN_REPOSITORIES, runBuild, type DrawnItem } from '../replay/build.js'
import { runCheck } from '../replay/check.js'
import { defaultConfigPath, loadReplayConfig, type LoadedReplayConfig } from '../replay/config.js'
import { runDiscovery, type Discovery, type DiscoveredRepository } from '../replay/discover.js'
import { createReplayFetch } from '../replay/fetch.js'
import { labelComment, type Label } from '../replay/label.js'
import { LABEL_PROMPT_VERSION } from '../replay/label-check.js'
import type { Rejection } from '../replay/select.js'
import {
  fromJsonl,
  hashText,
  readManifest,
  readOptional,
  replayDir,
  replayFiles,
  STAGES,
  toJsonl,
  writeAtomic,
  writeManifest,
  type Manifest,
  type StageName,
  type StageRecord,
} from '../replay/store.js'
import { DEFAULT_MAX_COST, parseNumber } from './score-args.js'

const REPLAY_FLAGS = {
  stage: { type: 'string' },
  'max-cost': { type: 'string' },
  'no-cache': { type: 'boolean' },
  config: { type: 'string' },
  dir: { type: 'string' },
  json: { type: 'boolean' },
} as const

// Longer rejection lists (common in discovery) are cut in the output; the build log has all.
const MAX_REJECTED_ROWS = 20

// Stages this version implements; the rest come with later milestones (spec 12).
const AVAILABLE_STAGES: StageName[] = ['build', 'label', 'check']

interface ReplayRun {
  name: string
  dir: string
  loaded: LoadedReplayConfig
  manifest: Manifest
  context: AppContext
  asJson: boolean
  // Covers every paid call of this invocation: the label model now, Jev later (spec 9.4).
  maxCost: number
  budget: Budget
  useCache: boolean
  // Set when the check stage stopped at --max-cost in this run.
  checkStop?: { sampled: number; unlabelled: string[] }
  // Set when `build` searched for candidate repositories instead of building (spec 10.3).
  discovery?: Discovery
}

export async function replayCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  if (positionals.length > 1)
    throw validationError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`)
  const name = positionals[0] ?? 'default'
  const stage = parseStage(values.stage)
  const maxCost = parseNumber('--max-cost', values['max-cost']) ?? DEFAULT_MAX_COST
  const configPath = resolve(context.cwd, values.config ?? defaultConfigPath(context.cwd, name))
  const loaded = await loadReplayConfig(configPath, name)
  const dir =
    values.dir === undefined ? replayDir(context.cwd, name) : resolve(context.cwd, values.dir)
  const run: ReplayRun = {
    name,
    dir,
    loaded,
    manifest: await readManifest(dir, name),
    context,
    asJson: values.json ?? false,
    maxCost,
    budget: createBudget(maxCost),
    useCache: !(values['no-cache'] ?? false),
  }
  assertPreRegistered(run)

  for (const next of stage === undefined ? AVAILABLE_STAGES : [stage]) {
    if (next === 'build') await buildStage(run)
    // Without --stage, stop at the first stage that could not complete.
    if (stage === undefined && !run.manifest.stages.build) break
    if (next === 'label') await labelStage(run)
    if (next === 'check') await checkStage(run)
  }
  const output = await renderReplay(run)
  if (run.checkStop) throw new BudgetStop(output)
  return output
}

// Once `build` has run, the config is frozen: its hash was recorded (spec 4.6, 10.2).
function assertPreRegistered(run: ReplayRun): void {
  const recorded = run.manifest.config_hash
  if (recorded === null || recorded === run.loaded.hash) return
  throw validationError(
    `The replay config ${relative(run.context.cwd, run.loaded.path)} changed after build (recorded ${recorded}, now ${run.loaded.hash})`,
    [
      'Restore the config as it was built, or copy the change into a config with a new replay name',
      `Run \`quiet-review-axi replay <new-name>\` to build the changed config`,
    ],
  )
}

async function buildStage(run: ReplayRun): Promise<void> {
  const record = run.manifest.stages.build
  if (record?.input_hash === run.loaded.hash) return
  const { context } = run
  const token = await requireGitHubToken(context.env, context.runGhAuthToken)
  const files = replayFiles(run.dir)
  const options = {
    config: run.loaded.config,
    client: createGitHubClient({
      token: token.token,
      fetch: createReplayFetch({ ...context, cacheDir: files.github }),
      callerPacesSearch: true,
    }),
    progress: (line: string) => context.stderr.write(`${line}\n`),
  }
  if (run.loaded.config.repositories.length === 0) {
    run.discovery = await runDiscovery(options)
    await writeAtomic(files.candidates, toJsonl(run.discovery.candidates))
    await writeAtomic(files.buildLog, toJsonl(run.discovery.rejected))
    return
  }
  const build = await runBuild(options)
  await writeAtomic(files.items, toJsonl(build.items))
  await writeAtomic(files.buildLog, toJsonl(build.rejected))
  const { summary } = build
  run.manifest.config_hash = run.loaded.hash
  run.manifest.stages.build = {
    input_hash: run.loaded.hash,
    detail: `${summary.repositories} repos, ${summary.bots} bots, ${summary.comments} comments from ${summary.prs} PRs`,
    completed_at: context.now().toISOString(),
    counts: { ...summary },
    warnings: build.warnings,
  }
  await writeManifest(run.dir, run.manifest)
}

async function labelStage(run: ReplayRun): Promise<void> {
  const files = replayFiles(run.dir)
  const itemsText = run.manifest.stages.build ? await readOptional(files.items) : null
  if (itemsText === null)
    throw validationError(`The build stage of replay ${run.name} has not run yet`, [
      `Run \`quiet-review-axi replay ${run.name} --stage build\` first`,
    ])
  const inputHash = hashText(itemsText)
  if (run.manifest.stages.label?.input_hash === inputHash) return
  const labels = fromJsonl<DrawnItem>(itemsText).map((item) => {
    const result = labelComment(item.evidence)
    return { id: item.id, label: result.label, reason: result.reason, signals: result.signals }
  })
  await writeAtomic(files.labels, toJsonl(labels))
  const count = (label: string) => labels.filter((entry) => entry.label === label).length
  const counts = { real: count('real'), noise: count('noise'), excluded: count('excluded') }
  const excludedByReason: Record<string, number> = {}
  for (const { reason } of labels)
    if (reason !== null) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1
  run.manifest.stages.label = {
    input_hash: inputHash,
    detail: `real ${counts.real}, noise ${counts.noise}, excluded ${counts.excluded}`,
    completed_at: run.context.now().toISOString(),
    counts,
    excluded_by_reason: excludedByReason,
  }
  await writeManifest(run.dir, run.manifest)
}

async function checkStage(run: ReplayRun): Promise<void> {
  const files = replayFiles(run.dir)
  const itemsText = await readOptional(files.items)
  const labelsText = run.manifest.stages.label ? await readOptional(files.labels) : null
  if (itemsText === null || labelsText === null)
    throw validationError(`The label stage of replay ${run.name} has not run yet`, [
      `Run \`quiet-review-axi replay ${run.name}\` to build and label the dataset first`,
    ])
  // The sample and the requests follow from the labels, the items and the prompt template.
  const inputHash = hashText(
    canonicalJson({
      labels: hashText(labelsText),
      items: run.manifest.stages.label?.input_hash ?? null,
      prompt: LABEL_PROMPT_VERSION,
    }),
  )
  // The model runs only when the inputs changed; review.jsonl is read back on every run.
  const previous = run.manifest.stages.check
  const { context } = run
  const userConfig = await loadUserConfig(context)
  const outcome = await runCheck({
    files,
    sample: { size: run.loaded.config.label_check.sample_size, seed: run.loaded.config.seed },
    items: fromJsonl<DrawnItem>(itemsText),
    labels: new Map(
      fromJsonl<{ id: string; label: Label }>(labelsText).map((entry) => [entry.id, entry.label]),
    ),
    needsModel: previous?.input_hash !== inputHash,
    model: {
      model: run.loaded.config.label_check.model,
      runId: `r-${randomBytes(4).toString('hex')}`,
      callLogPath: callLogPath(context.env),
      redact: createRedactor(secretsOf(context.env, userConfig)),
      progress: (line: string) => context.stderr.write(`${line}\n`),
      budget: run.budget,
      useCache: run.useCache,
      cacheDir: labelCacheDir(context.env),
      apiKey: () => {
        const found = findApiKey(openRouterProvider, context.env, userConfig)
        if (!found) throw missingKeyError(openRouterProvider)
        return found.key
      },
      fetch: context.fetch,
      sleep: context.sleep,
      random: context.random,
      now: context.now,
    },
  })
  if (outcome.kind === 'stopped') {
    run.checkStop = outcome
    return
  }
  const { record } = outcome
  if (previous?.input_hash === inputHash && sameOutcome(previous, record)) return
  run.manifest.stages.check = { input_hash: inputHash, ...record }
  await writeManifest(run.dir, run.manifest)
}

// Whether a re-run reached the same result, so the stage record stays as it was.
function sameOutcome(previous: StageRecord, next: Omit<StageRecord, 'input_hash'>): boolean {
  const outcome = (record: Partial<StageRecord>) =>
    canonicalJson({ ...record, input_hash: null, completed_at: null })
  return outcome(previous) === outcome(next)
}

async function renderReplay(run: ReplayRun): Promise<string> {
  const stages = STAGES.map((stage) => {
    if (stage === 'check' && run.checkStop)
      return {
        stage,
        status: 'stopped',
        detail: `${run.checkStop.sampled - run.checkStop.unlabelled.length} of ${run.checkStop.sampled} labelled, stopped at --max-cost ${run.maxCost}`,
      }
    const record = run.manifest.stages[stage]
    if (record) return { stage, status: record.status ?? 'done', detail: record.detail }
    if (stage === 'build' && run.discovery)
      return {
        stage,
        status: 'waiting',
        detail: `${run.discovery.candidates.length} of ${run.discovery.candidates.length + run.discovery.rejected.length} candidates qualify; list ${MIN_REPOSITORIES}-${MAX_REPOSITORIES} in the config`,
      }
    if (!AVAILABLE_STAGES.includes(stage))
      return { stage, status: 'unavailable', detail: 'not in this version yet' }
    return { stage, status: 'pending', detail: '' }
  })
  const view: Record<string, unknown> = {
    replay: run.name,
    dir: relative(run.context.cwd, run.dir) || '.',
    config: relative(run.context.cwd, run.loaded.path),
    config_hash: run.loaded.hash,
    stages,
  }
  if (run.checkStop) {
    view.stopped = 'max-cost'
    view.code = 'BUDGET_STOP'
    view.unlabelled = run.checkStop.unlabelled.length
    view.run_cost_usd = roundCost(run.budget.spent())
  }
  const labelCheck = run.manifest.stages.check?.label_check
  if (labelCheck) {
    view.label_model = labelCheck.model
    view.label_check_cost_usd = roundCost(labelCheck.cost_usd)
    view.trust = labelCheck.trust
    if (labelCheck.trust_reasons.length > 0) view.trust_reasons = labelCheck.trust_reasons
  }
  const warnings = [
    ...(run.manifest.stages.build?.warnings ?? []),
    ...(run.manifest.stages.check?.warnings ?? []),
  ]
  if (warnings.length > 0) view.warnings = warnings
  const excluded = Object.entries(run.manifest.stages.label?.excluded_by_reason ?? {})
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([reason, count]) => ({ reason, count }))
  if (excluded.length > 0) view.excluded = excluded
  if (run.discovery) view.candidates = run.discovery.candidates.map(candidateRow(run))
  const buildLog = await readOptional(replayFiles(run.dir).buildLog)
  const rejected = buildLog === null ? [] : fromJsonl<Rejection>(buildLog)
  if (rejected.length > MAX_REJECTED_ROWS) view.rejected_total = rejected.length
  if (rejected.length > 0)
    view.rejected = rejected
      .slice(0, MAX_REJECTED_ROWS)
      .map(({ kind, candidate, reason }) => ({ kind, candidate, reason }))
  const help = [...helpLines(run)]
  if (rejected.length > MAX_REJECTED_ROWS)
    help.push(
      `Run \`cat ${relative(run.context.cwd, replayFiles(run.dir).buildLog)}\` to see all ${rejected.length} rejected candidates with their reasons`,
    )
  if (run.asJson) return JSON.stringify({ ...view, help }, null, 2)
  return joinBlocks(encode(view), renderHelp(help))
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function candidateRow(run: ReplayRun) {
  return (candidate: DiscoveredRepository) => ({
    repository: candidate.repository,
    merged_prs: candidate.merged_prs,
    bot_prs: run.loaded.config.bots
      .filter((bot) => (candidate.bot_prs[bot] ?? 0) > 0)
      .map((bot) => `${bot} ${candidate.bot_prs[bot]}`)
      .join(', '),
  })
}

function helpLines(run: ReplayRun): string[] {
  const config = relative(run.context.cwd, run.loaded.path)
  if (run.checkStop)
    return [
      `Run \`quiet-review-axi replay ${run.name} --stage check --max-cost ${Math.max(0.5, run.maxCost * 2)}\` to label the rest; labels already paid for come from the cache`,
    ]
  if (run.discovery)
    return [
      `Run \`quiet-review-axi replay ${run.name}\` to build the dataset after listing ${MIN_REPOSITORIES}-${MAX_REPOSITORIES} qualifying repositories that cover at least 3 bots in \`repositories\` in ${config}, and committing it`,
    ]
  if (!run.manifest.stages.build)
    return [`Run \`quiet-review-axi replay ${run.name}\` to build and label the dataset`]
  if (!run.manifest.stages.label)
    return [`Run \`quiet-review-axi replay ${run.name} --stage label\` to label the dataset`]
  if (!run.manifest.stages.check)
    return [
      `Run \`quiet-review-axi replay ${run.name} --stage check --max-cost <usd>\` to check a sample of the labels with the label model (paid, needs OPENROUTER_API_KEY)`,
    ]
  if (run.manifest.stages.check.status === 'waiting')
    return [
      `Run \`quiet-review-axi replay ${run.name} --stage check\` after setting \`label\` to real, noise or excluded on each line of ${relative(run.context.cwd, replayFiles(run.dir).review)}, to record the reviewed labels`,
    ]
  return [
    `Run \`quiet-review-axi replay ${run.name} --stage check\` to record a label changed in ${relative(run.context.cwd, replayFiles(run.dir).review)} after the review`,
  ]
}

function parseStage(value: string | undefined): StageName | undefined {
  if (value === undefined) return undefined
  if (!(STAGES as readonly string[]).includes(value))
    throw validationError(`--stage must be one of ${STAGES.join(', ')}, not ${value}`)
  const stage = value as StageName
  if (!AVAILABLE_STAGES.includes(stage))
    throw validationError(`The ${stage} stage is not available in this version yet`, [
      `Run \`quiet-review-axi replay <name>\` to run the ${AVAILABLE_STAGES.slice(0, -1).join(', ')} and ${AVAILABLE_STAGES.at(-1)} stages`,
    ])
  return stage
}

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, options: REPLAY_FLAGS, allowPositionals: true, strict: true })
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : String(error), [
      'Run `quiet-review-axi replay --help` to see the flags',
    ])
  }
}

export const REPLAY_HELP = joinBlocks(
  encode({
    command: 'replay',
    usage:
      'quiet-review-axi replay [<name>] [--stage <build|label|check|score|evaluate>] [--config <file>] [--dir <path>] [--max-cost <usd>] [--no-cache]',
    description:
      'Builds the public replay dataset, labels it, and checks a sample of the labels with an AI model and the maintainer, in resumable stages stored in a replay directory',
    stages: {
      build: 'Select repositories, bots and comments from GitHub per the replay config (read only)',
      label: 'Label every drawn comment real, noise or excluded from the recorded evidence',
      check:
        'Ask the label model (paid, OpenRouter key) about a seeded sample, report agreement, and write the disagreements to review.jsonl for the maintainer',
      score: 'Not available in this version yet',
      evaluate: 'Not available in this version yet',
    },
    flags: {
      '--stage <build|label|check|score|evaluate>':
        'Run only this stage (default: every stage not yet complete)',
      '--config <file>': 'Replay config (default: replay/<name>.config.json)',
      '--dir <path>': 'Replay directory (default: .quiet-review/replays/<name>)',
      '--max-cost <usd>':
        'Stop before a paid call would pass this run total (default: 0.50; 0 = cache only)',
      '--no-cache': 'Skip cache reads and make fresh label-model calls',
      '--json': 'Emit one JSON document',
    },
    exit_codes:
      '0 ok, 1 unexpected, 2 validation or changed config, 3 budget stop, 4 key, provider or GitHub problem',
  }),
  renderHelp([
    'Run `quiet-review-axi replay public-v1` to build, label and check the replay configured in replay/public-v1.config.json',
    'Run `quiet-review-axi replay public-v1 --stage check` after filling review.jsonl, to record the reviewed labels',
  ]),
)
