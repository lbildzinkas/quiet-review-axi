import type { AppContext } from '../context.js'
import { describeCutoffs, resolveCutoffs } from '../core/cutoffs.js'
import type { Item } from '../core/items.js'
import { buildRequests, type RequestHeader } from '../core/state.js'
import { decideItems } from '../core/verdict.js'
import { findApiKey, loadRepoConfig, loadUserConfig, missingKeyError } from '../infra/config.js'
import { loadFindings } from '../inputs/findings.js'
import { createGitHubClient, requireGitHubToken } from '../inputs/github.js'
import {
  fetchPullRequest,
  formatRef,
  normalizeComments,
  parsePullRequestRef,
} from '../inputs/pull-request.js'
import { QUESTION_PACK_VERSION } from '../core/questions.js'
import { PROVIDERS } from '../jev/providers.js'
import { runRequests } from '../jev/run-requests.js'
import { renderScore, roundCost } from '../output/render.js'
import { parseScoreArgs, type ScoreOptions } from './score-args.js'

interface ScoreInput {
  kind: 'pr' | 'findings'
  label: string
  // How to re-run this command in help lines, for example `score acme/widgets#412`.
  command: string
  header: RequestHeader
  items: Item[]
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
      ? await pullRequestInput(options, context)
      : await findingsInput(options, context)
  const requests = buildRequests({ header: input.header, items: input.items })
  const run = await runRequests({
    provider,
    requests,
    apiKey: () => {
      const found = findApiKey(provider, context.env, userConfig)
      if (!found) throw missingKeyError(provider)
      return found.key
    },
    fetch: context.fetch,
    sleep: context.sleep,
    random: context.random,
  })
  const decisions = decideItems({
    items: input.items,
    calls: requests.map((request) => request.itemKeys),
    answers: run.answers,
    cutoffs,
  })
  const snapshots = [...new Set(run.calls.map((call) => call.result.snapshot))]
  const cutoffDescription = describeCutoffs(cutoffs, snapshots)
  const costUsd = run.calls.reduce(
    (total, call) => total + (call.cached ? 0 : call.result.costUsd),
    0,
  )
  const isCached = run.calls.length > 0 && run.calls.every((call) => call.cached)
  return renderScore({
    mode: options.output,
    showAll: options.all,
    showFull: options.full,
    source: {
      kind: input.kind,
      label: input.label,
      title: input.header.title ?? null,
      command: input.command,
    },
    cutoffs: cutoffDescription,
    provider: provider.name,
    snapshots,
    calls: run.calls.length,
    costUsd,
    isCached,
    decisions,
    answers: run.answers,
    run: {
      provider: provider.name,
      model_requested: provider.model,
      model_returned: snapshots,
      request_ids: run.calls.map((call) => call.result.responseId ?? null),
      cache_keys: run.calls.map((call) => call.cacheKey),
      cached: isCached,
      question_pack: QUESTION_PACK_VERSION,
      questions: requests.reduce(
        (total, request) => total + Object.keys(request.questions).length,
        0,
      ),
      input_tokens: run.calls.reduce((total, call) => total + call.result.inputTokens, 0),
      cost_usd: roundCost(costUsd),
      retries: run.calls.reduce((total, call) => total + call.result.retries, 0),
    },
  })
}

async function pullRequestInput(options: ScoreOptions, context: AppContext): Promise<ScoreInput> {
  const ref = parsePullRequestRef(options.target ?? '')
  const token = await requireGitHubToken(context.env, context.runGhAuthToken)
  const client = createGitHubClient({ token: token.token, fetch: context.fetch })
  const pull = await fetchPullRequest(client, ref)
  const label = formatRef(ref)
  return {
    kind: 'pr',
    label,
    command: `score ${label}`,
    header: { repository: `${ref.owner}/${ref.repo}`, title: pull.title },
    items: normalizeComments(pull.comments, options.authors),
  }
}

async function findingsInput(options: ScoreOptions, context: AppContext): Promise<ScoreInput> {
  const file = options.findings ?? ''
  const findings = await loadFindings({ file, cwd: context.cwd })
  return {
    kind: 'findings',
    label: file,
    command: `score --findings ${file}`,
    header: findings.title === undefined ? {} : { title: findings.title },
    items: findings.items,
  }
}
