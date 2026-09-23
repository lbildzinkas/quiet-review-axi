import type { AppContext } from '../context.js'
import { describeCutoffs, resolveCutoffs } from '../core/cutoffs.js'
import { buildRequests } from '../core/state.js'
import { decideItems } from '../core/verdict.js'
import { loadFindings } from '../inputs/findings.js'
import { PROVIDERS } from '../jev/providers.js'
import type { Answer } from '../jev/schema.js'
import { renderCompact } from '../output/render.js'
import { parseScoreArgs } from './score-args.js'

export async function scoreCommand(args: string[], context: AppContext): Promise<string> {
  const options = parseScoreArgs(args)
  const provider = PROVIDERS.openrouter
  const input = await loadFindings({ file: options.findings, cwd: context.cwd })
  const requests = buildRequests({ header: { title: input.title }, items: input.items })
  const answers: Record<string, Answer> = {}
  for (const request of requests) {
    const result = await provider.decide(request, {
      apiKey: context.env[provider.keyEnv] ?? '',
      fetch: context.fetch,
      sleep: context.sleep,
      random: context.random,
    })
    Object.assign(answers, result.answers)
  }
  const cutoffs = resolveCutoffs()
  const decisions = decideItems({ items: input.items, answers, cutoffs })
  return renderCompact({
    header: { source: options.findings, cutoffs: describeCutoffs(cutoffs) },
    decisions,
    help: [],
  })
}
