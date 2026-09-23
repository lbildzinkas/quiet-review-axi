import { randomBytes } from 'node:crypto'
import type { AppContext } from '../context.js'
import { describeCutoffs, resolveCutoffs } from '../core/cutoffs.js'
import type { Item } from '../core/items.js'
import { QUESTION_PACK_VERSION } from '../core/questions.js'
import { buildRequests, estimateRequestTokens, type RequestHeader } from '../core/state.js'
import { decideItems } from '../core/verdict.js'
import { BudgetStop } from '../errors.js'
import { cacheKey, readCacheEntry } from '../infra/cache.js'
import {
  findApiKey,
  loadRepoConfig,
  loadUserConfig,
  missingKeyError,
  type UserConfig,
} from '../infra/config.js'
import { cacheDir, callLogPath } from '../infra/paths.js'
import { createRedactor } from '../infra/redact.js'
import { loadFindings } from '../inputs/findings.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import {
  fetchPullRequest,
  formatRef,
  normalizeComments,
  parsePullRequestRef,
} from '../inputs/pull-request.js'
import type { JevProvider } from '../jev/provider.js'
import { PROVIDERS } from '../jev/providers.js'
import { runRequests } from '../jev/run-requests.js'
import { renderDryRun, renderScore, roundCost } from '../output/render.js'
import { assertPrivateAllowed, dryRunNotice, sentNotice } from './privacy.js'
import { parseScoreArgs, type ScoreOptions } from './score-args.js'

export interface ScoreInput {
  kind: 'pr' | 'findings'
  // Whether the private-data notice applies: private repositories and findings files.
  needsNotice: boolean
  label: string
  // How to re-run this command in help lines, for example `score acme/widgets#412`.
  command: string
  header: RequestHeader
  items: Item[]
  warnings: string[]
}

export async function scoreCommand(args: string[], context: AppContext): Promise<string> {
  const options = parseScoreArgs(args)
  const userConfig = await loadUserConfig(context)
  const repoConfig = await loadRepoConfig(context)
  const cutoffs = resolveCutoffs({
    flags: { collapseBelow: options.collapseBelow, keepAt: options.keepAt },
    repoConfig: repoConfig.cutoffs,
    userConfig: userConfig.cutoffs,
  })
  const provider = PROVIDERS[options.provider ?? userConfig.provider ?? 'openrouter']
  const input =
    options.findings === undefined
      ? await pullRequestInput(options, context, userConfig, provider)
      : await findingsInput(options, context)
  const requests = buildRequests({ header: input.header, items: input.items })
  const cacheDirectory = cacheDir(context.env)

  if (options.dryRun) {
    const cachedFlags = await Promise.all(
      requests.map(async (request) => {
        const key = cacheKey({
          provider: provider.name,
          endpoint: provider.endpoint,
          body: provider.buildBody(request),
        })
        return !options.noCache && (await readCacheEntry(cacheDirectory, key)) !== null
      }),
    )
    return renderDryRun({
      mode: options.output,
      source: sourceView(input),
      provider,
      cutoffs: describeCutoffs(cutoffs, []),
      notice: input.needsNotice ? dryRunNotice(input.kind, provider) : null,
      items: input.items.length,
      requests: requests.map((request, index) => ({
        body: provider.buildBody(request),
        items: request.itemKeys.length,
        estimatedTokens: estimateRequestTokens(request),
        isCached: cachedFlags[index] ?? false,
      })),
    })
  }

  const run = await runRequests({
    command: 'score',
    runId: `r-${randomBytes(4).toString('hex')}`,
    provider,
    requests,
    maxCostUsd: options.maxCost,
    useCache: !options.noCache,
    cacheDir: cacheDirectory,
    callLogPath: callLogPath(context.env),
    notice: input.needsNotice ? sentNotice(input.kind, provider) : undefined,
    apiKey: () => requireApiKey(provider, context, userConfig),
    fetch: context.fetch,
    sleep: context.sleep,
    random: context.random,
    now: context.now,
    redact: createRedactor(secretsOf(context, userConfig)),
  })
  const scoredKeys = new Set(run.calls.flatMap((call) => call.request.itemKeys))
  const scoredItems = input.items.filter((item) => scoredKeys.has(item.key))
  const decisions = decideItems({
    items: scoredItems,
    calls: run.calls.map((call) => call.request.itemKeys),
    answers: run.answers,
    cutoffs,
  })
  const snapshots = [...new Set(run.calls.map((call) => call.result.snapshot))]
  const costUsd = run.calls.reduce(
    (total, call) => total + (call.cached ? 0 : call.result.costUsd),
    0,
  )
  const isCached = run.calls.length > 0 && run.calls.every((call) => call.cached)
  const isStopped = run.skipped.length > 0
  const output = renderScore({
    mode: options.output,
    showAll: options.all,
    showFull: options.full,
    source: sourceView(input),
    cutoffs: describeCutoffs(cutoffs, snapshots),
    provider: provider.name,
    snapshots,
    calls: run.calls.length,
    costUsd,
    isCached,
    decisions,
    answers: run.answers,
    notice: input.needsNotice && run.calls.length > 0 ? sentNotice(input.kind, provider) : null,
    unscored: isStopped
      ? input.items.filter((item) => !scoredKeys.has(item.key)).map((item) => item.id)
      : [],
    stop: isStopped ? { maxCost: options.maxCost } : null,
    run: {
      provider: provider.name,
      model_requested: provider.model,
      model_returned: snapshots,
      request_ids: run.calls.map((call) => call.result.responseId ?? null),
      cache_keys: run.calls.map((call) => call.cacheKey),
      cached: isCached,
      question_pack: QUESTION_PACK_VERSION,
      questions: run.calls.reduce(
        (total, call) => total + Object.keys(call.request.questions).length,
        0,
      ),
      input_tokens: run.calls.reduce((total, call) => total + call.result.inputTokens, 0),
      cost_usd: roundCost(costUsd),
      retries: run.calls.reduce((total, call) => total + call.result.retries, 0),
    },
  })
  if (isStopped) throw new BudgetStop(output)
  return output
}

function sourceView(input: ScoreInput) {
  return {
    kind: input.kind,
    label: input.label,
    title: input.header.title ?? null,
    command: input.command,
    warnings: input.warnings,
  }
}

function requireApiKey(provider: JevProvider, context: AppContext, userConfig: UserConfig): string {
  const found = findApiKey(provider, context.env, userConfig)
  if (!found) throw missingKeyError(provider)
  return found.key
}

export function secretsOf(context: AppContext, userConfig: UserConfig): (string | undefined)[] {
  return [
    context.env.OPENROUTER_API_KEY,
    context.env.TYPESAFE_API_KEY,
    context.env.GITHUB_TOKEN,
    context.env.GH_TOKEN,
    userConfig.keys?.openrouter,
    userConfig.keys?.typesafe,
  ]
}

async function pullRequestInput(
  options: ScoreOptions,
  context: AppContext,
  userConfig: UserConfig,
  provider: JevProvider,
): Promise<ScoreInput> {
  const ref = parsePullRequestRef(options.target ?? '')
  const token = await requireGitHubToken(context.env, context.runGhAuthToken)
  const client = createGitHubClient({ token: token.token, fetch: context.fetch })
  const pull = await fetchPullRequest(client, ref)
  const label = formatRef(ref)
  assertPrivateAllowed({
    repository: `${ref.owner}/${ref.repo}`,
    isPrivate: pull.isPrivate,
    allowPrivateFlag: options.allowPrivate,
    allowList: userConfig.allow_private ?? [],
    provider,
  })
  return {
    kind: 'pr',
    needsNotice: pull.isPrivate,
    label,
    command: `score ${label}`,
    header: { repository: `${ref.owner}/${ref.repo}`, title: pull.title },
    items: normalizeComments(pull.comments, options.authors),
    warnings: [],
  }
}

async function findingsInput(options: ScoreOptions, context: AppContext): Promise<ScoreInput> {
  const file = options.findings ?? ''
  const findings = await loadFindings({
    file,
    cwd: context.cwd,
    repoRoot: options.repoRoot,
    readStdin: context.readStdin,
  })
  return {
    kind: 'findings',
    needsNotice: true,
    label: file === '-' ? 'stdin' : file,
    command: `score --findings ${file}`,
    header: findings.title === undefined ? {} : { title: findings.title },
    items: findings.items,
    warnings: findings.warnings,
  }
}
