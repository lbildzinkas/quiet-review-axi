import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import type { AppContext } from '../context.js'
import { validationError } from '../errors.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import { joinBlocks, renderHelp } from '../output/render.js'
import { MAX_REPOSITORIES, MIN_REPOSITORIES, runBuild, type DrawnItem } from '../replay/build.js'
import { defaultConfigPath, loadReplayConfig, type LoadedReplayConfig } from '../replay/config.js'
import { runDiscovery, type Discovery, type DiscoveredRepository } from '../replay/discover.js'
import { createReplayFetch } from '../replay/fetch.js'
import { findApiKey, loadUserConfig, missingKeyError } from '../infra/config.js'
import { openRouterProvider } from '../jev/openrouter.js'
import { labelComment, type Label } from '../replay/label.js'
import { LABEL_PROMPT_VERSION } from '../replay/label-check.js'
import { runCheck } from '../replay/check.js'
import { canonicalJson } from '../infra/canonical-json.js'
import { labelCacheDir } from '../infra/paths.js'
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

const REPLAY_FLAGS = {
  stage: { type: 'string' },
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
  // Set when `build` searched for candidate repositories instead of building (spec 10.3).
  discovery?: Discovery
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
  }
  assertPreRegistered(run)

  for (const next of stage === undefined ? AVAILABLE_STAGES : [stage]) {
    if (next === 'build') await buildStage(run)
    // Without --stage, stop at the first stage that could not complete.
    if (stage === undefined && !run.manifest.stages.build) break
    if (next === 'label') await labelStage(run)
    if (next === 'check') await checkStage(run)
  }
  return await renderReplay(run)
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
  const record = await runCheck({
    files,
    sample: { size: run.loaded.config.label_check.sample_size, seed: run.loaded.config.seed },
    items: fromJsonl<DrawnItem>(itemsText),
    labels: new Map(
      fromJsonl<{ id: string; label: Label }>(labelsText).map((entry) => [entry.id, entry.label]),
    ),
    needsModel: previous?.input_hash !== inputHash,
    model: {
      model: run.loaded.config.label_check.model,
      useCache: true,
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
  if (run.discovery)
    return [
      `Run \`quiet-review-axi replay ${run.name}\` to build the dataset after listing ${MIN_REPOSITORIES}-${MAX_REPOSITORIES} qualifying repositories that cover at least 3 bots in \`repositories\` in ${config}, and committing it`,
    ]
  if (!run.manifest.stages.build)
    return [`Run \`quiet-review-axi replay ${run.name}\` to build and label the dataset`]
  if (!run.manifest.stages.label)
    return [`Run \`quiet-review-axi replay ${run.name} --stage label\` to label the dataset`]
  if (run.manifest.stages.check?.status === 'waiting')
    return [
      `Run \`quiet-review-axi replay ${run.name} --stage check\` after setting \`label\` to real, noise or excluded on each line of ${relative(run.context.cwd, replayFiles(run.dir).review)}, to record the reviewed labels`,
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
      'Builds the public replay dataset and its automatic labels, in resumable stages stored in a replay directory',
    stages: {
      build: 'Select repositories, bots and comments from GitHub per the replay config (read only)',
      label: 'Label every drawn comment real, noise or excluded from the recorded evidence',
      check: 'Not available in this version yet',
      score: 'Not available in this version yet',
      evaluate: 'Not available in this version yet',
    },
    flags: {
      '--stage <build|label|check|score|evaluate>':
        'Run only this stage (default: every stage not yet complete)',
      '--config <file>': 'Replay config (default: replay/<name>.config.json)',
      '--dir <path>': 'Replay directory (default: .quiet-review/replays/<name>)',
      '--json': 'Emit one JSON document',
    },
    exit_codes: '0 ok, 1 unexpected, 2 validation or changed config, 4 GitHub problem',
  }),
  renderHelp([
    'Run `quiet-review-axi replay public-v1` to build and label the replay configured in replay/public-v1.config.json',
  ]),
)
