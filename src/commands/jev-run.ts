import { randomBytes } from 'node:crypto'
import type { AppContext } from '../context.js'
import type { QuestionPack } from '../core/questions.js'
import { findApiKey, missingKeyError, secretsOf, type UserConfig } from '../infra/config.js'
import { cacheDir, callLogPath } from '../infra/paths.js'
import { createRedactor } from '../infra/redact.js'
import type { JevJudgeOptions } from '../jev/judge.js'
import type { JevProvider } from '../jev/provider.js'

export interface JevRunFlags {
  maxCost: number
  noCache: boolean
}

// Everything a Jev judge needs from the CLI run: cache, budget, cost log, key and redaction
// (spec 9). The key is read only when a paid call is about to be made.
export function jevJudgeOptions(input: {
  command: string
  context: AppContext
  userConfig: UserConfig
  provider: JevProvider
  pack: QuestionPack
  flags: JevRunFlags
}): JevJudgeOptions {
  const { context, userConfig, provider } = input
  return {
    command: input.command,
    runId: `r-${randomBytes(4).toString('hex')}`,
    pack: input.pack,
    provider,
    maxCostUsd: input.flags.maxCost,
    useCache: !input.flags.noCache,
    cacheDir: cacheDir(context.env),
    callLogPath: callLogPath(context.env),
    apiKey: () => {
      const found = findApiKey(provider, context.env, userConfig)
      if (!found) throw missingKeyError(provider)
      return found.key
    },
    fetch: context.fetch,
    sleep: context.sleep,
    random: context.random,
    now: context.now,
    redact: createRedactor(secretsOf(context.env, userConfig)),
  }
}
