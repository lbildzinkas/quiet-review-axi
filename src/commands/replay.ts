import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { QUESTION_PACK_VERSION, BUILT_IN_PACK } from '../core/questions.js'
import { BudgetStop, validationError } from '../errors.js'
import { formatCutoff, type UserConfigCutoffs } from '../core/cutoffs.js'
import { loadUserConfig, writeUserCutoffs } from '../infra/config.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import { PROVIDERS } from '../jev/providers.js'
import { joinBlocks, renderHelp, resumeLimit, roundCost } from '../output/render.js'
import { MAX_REPOSITORIES, MIN_REPOSITORIES, runBuild, type DrawnItem } from '../replay/build.js'
import { defaultConfigPath, loadReplayConfig, type LoadedReplayConfig } from '../replay/config.js'
import { runDiscovery, type Discovery, type DiscoveredRepository } from '../replay/discover.js'
import { createReplayFetch } from '../replay/fetch.js'
import { evaluateReplay, type ReplayResult } from '../replay/evaluate.js'
import { readFinalLabels } from '../replay/final-labels.js'
import { labelComment } from '../replay/label.js'
import { scoreLabelledItems, type ScoreRow } from '../replay/score.js'
import type { Rejection } from '../replay/select.js'
import {
  appendJsonl,
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
} from '../replay/store.js'
import { jevJudgeOptions } from './jev-run.js'
import { DEFAULT_MAX_COST, parseNumber, parseProvider } from './score-args.js'

const REPLAY_FLAGS = {
  stage: { type: 'string' },
  config: { type: 'string' },
  dir: { type: 'string' },
  provider: { type: 'string' },
  'max-cost': { type: 'string' },
  'no-cache': { type: 'boolean' },
  json: { type: 'boolean' },
} as const

// Longer rejection lists (common in discovery) are cut in the output; the build log has all.
const MAX_REJECTED_ROWS = 20

// Stages this version implements; the rest come with later milestones (spec 12).
const AVAILABLE_STAGES: StageName[] = ['build', 'label', 'score', 'evaluate']

interface ReplayRun {
  name: string
  dir: string
  loaded: LoadedReplayConfig
  manifest: Manifest
  context: AppContext
  asJson: boolean
  flags: ReplayFlags
  // Set when `build` searched for candidate repositories instead of building (spec 10.3).
  discovery?: Discovery
  // Set when `score` stopped at --max-cost (spec 9.4).
  stopped?: { scored: number; total: number }
  // Set when this run's `evaluate` wrote calibrated cut-offs to the user config (spec 6.2).
  cutoffsWritten?: { written: string; replaced: string | null }
}

interface ReplayFlags {
  provider?: 'openrouter' | 'typesafe'
  maxCost: number
  noCache: boolean
}

export async function replayCommand(args: string[], context: AppContext): Promise<string> {
  const { values, positionals } = parseFlags(args)
  if (positionals.length > 1)
    throw validationError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`)
  const name = positionals[0] ?? 'default'
  const stage = parseStage(values.stage)
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
    flags: {
      provider: parseProvider(values.provider),
      maxCost: parseNumber('--max-cost', values['max-cost']) ?? DEFAULT_MAX_COST,
      noCache: values['no-cache'] ?? false,
    },
  }
  assertPreRegistered(run)

  for (const next of stage === undefined ? AVAILABLE_STAGES : [stage]) {
    if (next === 'build') await buildStage(run)
    if (next === 'label') await labelStage(run)
    if (next === 'score') await scoreStage(run)
    if (next === 'evaluate') await evaluateStage(run)
    // Without --stage, stop at the first stage that could not complete.
    if (stage === undefined && !run.manifest.stages[next]) break
  }
  const output = await renderReplay(run)
  if (run.stopped) throw new BudgetStop(output)
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

// Scores every labelled item with Jev (spec 4.6). The question pack is part of the
// pre-registration: once the stage has scored with one pack, it never re-scores with another.
async function scoreStage(run: ReplayRun): Promise<void> {
  const files = replayFiles(run.dir)
  const itemsText = run.manifest.stages.label ? await readOptional(files.items) : null
  const labels = run.manifest.stages.label ? await readFinalLabels(run.dir) : null
  if (itemsText === null || labels === null)
    throw validationError(`The label stage of replay ${run.name} has not run yet`, [
      `Run \`quiet-review-axi replay ${run.name} --stage label\` first`,
    ])
  const inputHash = hashText(`${hashText(itemsText)}\n${hashText(labels.text)}`)
  const record = run.manifest.stages.score
  if (record?.input_hash === inputHash) return
  if (record?.question_pack !== undefined && record.question_pack !== QUESTION_PACK_VERSION)
    throw validationError(
      `Replay ${run.name} was scored with question pack ${record.question_pack}; this build carries ${QUESTION_PACK_VERSION}`,
      [
        `Run \`quiet-review-axi gate ${run.name}\` to check the new pack against this replay`,
        'Run `quiet-review-axi replay <new-name>` to test a reworked pack under a new replay name',
      ],
    )
  const { context } = run
  const userConfig = await loadUserConfig(context)
  const provider = PROVIDERS[run.flags.provider ?? userConfig.provider ?? 'openrouter']
  context.stderr.write(`score: scoring labelled items with ${provider.model}\n`)
  const outcome = await scoreLabelledItems({
    items: fromJsonl<DrawnItem>(itemsText),
    labels: labels.labels,
    judgeOptions: jevJudgeOptions({
      command: 'replay',
      context,
      userConfig,
      provider,
      pack: BUILT_IN_PACK,
      flags: run.flags,
    }),
  })
  if (outcome.isStopped) {
    run.stopped = { scored: outcome.rows.length, total: outcome.total }
    return
  }
  await writeAtomic(files.scores, toJsonl(outcome.rows))
  const costUsd = roundCost(outcome.costUsd)
  run.manifest.stages.score = {
    input_hash: inputHash,
    detail: `${outcome.rows.length} items, ${outcome.calls} calls, $${costUsd}`,
    completed_at: context.now().toISOString(),
    counts: { items: outcome.rows.length, calls: outcome.calls, cached_calls: outcome.cachedCalls },
    question_pack: QUESTION_PACK_VERSION,
    provider: provider.name,
    snapshots: outcome.snapshots,
    cost_usd: costUsd,
  }
  await writeManifest(run.dir, run.manifest)
}

// Computes the metrics and applies the pass rule (spec 10.7, 10.8); on a pass, writes the
// calibrated cut-offs to the user config (spec 6.2). Every evaluation is logged.
async function evaluateStage(run: ReplayRun): Promise<void> {
  const files = replayFiles(run.dir)
  const scoring = run.manifest.stages.score
  const scoresText = scoring ? await readOptional(files.scores) : null
  const itemsText = await readOptional(files.items)
  const labels = await readFinalLabels(run.dir)
  if (!scoring || scoresText === null || itemsText === null || labels === null)
    throw validationError(`The score stage of replay ${run.name} has not run yet`, [
      `Run \`quiet-review-axi replay ${run.name} --stage score\` first`,
    ])
  const inputHash = hashText(
    [itemsText, labels.text, scoresText, run.loaded.hash].map(hashText).join('\n'),
  )
  if (run.manifest.stages.evaluate?.input_hash === inputHash) return
  const { context } = run
  const result = evaluateReplay({
    replay: run.name,
    config: run.loaded.config,
    items: fromJsonl<DrawnItem>(itemsText),
    labels: labels.labels,
    scores: fromJsonl<ScoreRow>(scoresText),
    scoring: {
      question_pack: scoring.question_pack ?? '',
      provider: scoring.provider ?? '',
      calls: scoring.counts?.calls ?? 0,
      cost_usd: scoring.cost_usd ?? 0,
    },
    excludedByReason: run.manifest.stages.label?.excluded_by_reason ?? {},
    evaluatedAt: context.now().toISOString(),
  })
  const [snapshot] = result.snapshots
  if (result.calibrated_cutoffs && result.best_threshold !== null && snapshot !== undefined) {
    const current = (await loadUserConfig(context)).cutoffs
    if (current?.collapse_below !== undefined || current?.keep_at !== undefined)
      context.stderr.write(`evaluate: replacing cut-offs ${describeUserCutoffs(current)}\n`)
    const { path } = await writeUserCutoffs(context, {
      ...result.calibrated_cutoffs,
      replay: run.name,
      snapshot,
      tested_collapse_below: result.best_threshold,
      written_at: result.evaluated_at.slice(0, 10),
    })
    result.cutoffs_written = `${describeUserCutoffs(result.calibrated_cutoffs, false)} -> ${path}`
    run.cutoffsWritten = {
      written: result.cutoffs_written,
      replaced:
        current?.collapse_below !== undefined || current?.keep_at !== undefined
          ? describeUserCutoffs(current)
          : null,
    }
  }
  await writeAtomic(files.result, `${JSON.stringify(result, null, 2)}\n`)
  await appendJsonl(files.runs, runLogLine(result, 'evaluate'))
  run.manifest.stages.evaluate = {
    input_hash: inputHash,
    detail: evaluateDetail(result),
    completed_at: result.evaluated_at,
    counts: { items: result.items, real: result.real, noise: result.noise },
  }
  await writeManifest(run.dir, run.manifest)
}

function evaluateDetail(result: ReplayResult): string {
  if (result.verdict === 'refused') return `refused: ${result.refusal}`
  const auroc = result.auroc === null ? 'n/a' : String(Number(result.auroc.toFixed(3)))
  const threshold = result.best_threshold === null ? 'none' : String(result.best_threshold)
  return `${result.verdict}: auroc ${auroc}, best threshold ${threshold}`
}

// One line per evaluation or gate run: the pack, the snapshots and the results, with no
// comment text, so the log can be summarized into the committed result file.
export function runLogLine(result: ReplayResult, kind: string) {
  return {
    ts: result.evaluated_at,
    kind,
    replay: result.replay,
    question_pack: result.question_pack,
    provider: result.provider,
    snapshots: result.snapshots,
    verdict: result.verdict,
    items: result.items,
    real: result.real,
    noise: result.noise,
    auroc: result.auroc,
    best_threshold: result.best_threshold,
    noise_collapsed: result.noise_collapsed,
    real_hidden: result.real_hidden,
    keep_precision: result.keep_precision,
  }
}

function describeUserCutoffs(cutoffs: UserConfigCutoffs, withProvenance = true): string {
  const parts: string[] = []
  if (cutoffs.collapse_below !== undefined)
    parts.push(`collapse<${formatCutoff(cutoffs.collapse_below)}`)
  if (cutoffs.keep_at !== undefined) parts.push(`keep>=${formatCutoff(cutoffs.keep_at)}`)
  if (!withProvenance) return parts.join(' ')
  const provenance =
    cutoffs.replay !== undefined ? `calibrated by replay ${cutoffs.replay}` : 'hand-set'
  return `${parts.join(' ')} (${provenance})`
}

async function renderReplay(run: ReplayRun): Promise<string> {
  const stages = STAGES.map((stage) => {
    const record = run.manifest.stages[stage]
    if (stage === 'score' && run.stopped)
      return {
        stage,
        status: 'stopped',
        detail: `${run.stopped.scored} of ${run.stopped.total} items scored; --max-cost ${run.flags.maxCost} reached`,
      }
    if (record) return { stage, status: 'done', detail: record.detail }
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
  if (run.cutoffsWritten) {
    view.cutoffs_written = run.cutoffsWritten.written
    if (run.cutoffsWritten.replaced !== null) view.cutoffs_replaced = run.cutoffsWritten.replaced
  }
  const warnings = run.manifest.stages.build?.warnings ?? []
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
  const help = run.stopped
    ? [
        `Run \`quiet-review-axi replay ${run.name} --max-cost ${resumeLimit(run.flags.maxCost)}\` to resume; results already paid for are cached and cost nothing`,
      ]
    : [...helpLines(run)]
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
  if (run.discovery)
    return [
      `Run \`quiet-review-axi replay ${run.name}\` to build the dataset after listing ${MIN_REPOSITORIES}-${MAX_REPOSITORIES} qualifying repositories that cover at least 3 bots in \`repositories\` in ${config}, and committing it`,
    ]
  if (!run.manifest.stages.build)
    return [`Run \`quiet-review-axi replay ${run.name}\` to build and label the dataset`]
  if (!run.manifest.stages.label)
    return [`Run \`quiet-review-axi replay ${run.name} --stage label\` to label the dataset`]
  if (run.manifest.stages.evaluate)
    return [`Run \`quiet-review-axi report ${run.name}\` to see the metrics with their 95% ranges`]
  if (!run.manifest.stages.score)
    return [
      `Run \`quiet-review-axi replay ${run.name}\` to score the labelled items with Jev (paid; --max-cost limits the spend)`,
    ]
  return [
    `Run \`quiet-review-axi replay ${run.name} --stage label\` to recompute the labels from the recorded evidence`,
  ]
}

function parseStage(value: string | undefined): StageName | undefined {
  if (value === undefined) return undefined
  if (!(STAGES as readonly string[]).includes(value))
    throw validationError(`--stage must be one of ${STAGES.join(', ')}, not ${value}`)
  const stage = value as StageName
  if (!AVAILABLE_STAGES.includes(stage))
    throw validationError(`The ${stage} stage is not available in this version yet`, [
      `Run \`quiet-review-axi replay <name>\` to run the ${AVAILABLE_STAGES.join(' and ')} stages`,
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
      'quiet-review-axi replay [<name>] [--stage <build|label|check|score|evaluate>] [--config <file>] [--dir <path>]',
    description:
      'Builds the public replay dataset, labels it, scores it with Jev and evaluates the pre-registered pass rule, in resumable stages stored in a replay directory',
    stages: {
      build: 'Select repositories, bots and comments from GitHub per the replay config (read only)',
      label: 'Label every drawn comment real, noise or excluded from the recorded evidence',
      check: 'Not available in this version yet',
      score: 'Score every labelled comment with Jev, one request per pull request (paid)',
      evaluate:
        'Compute AUROC, the threshold sweep and 95% ranges, apply the pass rule, and on a pass write calibrated cut-offs to the user config',
    },
    flags: {
      '--stage <build|label|check|score|evaluate>':
        'Run only this stage (default: every stage not yet complete)',
      '--config <file>': 'Replay config (default: replay/<name>.config.json)',
      '--dir <path>': 'Replay directory (default: .quiet-review/replays/<name>)',
      '--provider <openrouter|typesafe>': 'Jev backend (default: openrouter, or the user config)',
      '--max-cost <usd>':
        'Stop before a paid call would pass this run total (default: 0.50; 0 = cache only)',
      '--no-cache': 'Skip cache reads and make fresh calls',
      '--json': 'Emit one JSON document',
    },
    exit_codes:
      '0 ok (a failing pass rule is data, not an error), 1 unexpected, 2 validation or changed config, 3 budget stop, 4 key, provider or GitHub problem',
  }),
  renderHelp([
    'Run `quiet-review-axi replay public-v1` to run every stage of the replay configured in replay/public-v1.config.json',
    'Run `quiet-review-axi report public-v1` to see its result',
  ]),
)
