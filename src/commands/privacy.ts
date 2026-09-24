import { QuietReviewError } from '../errors.js'
import type { JevProvider } from '../jev/provider.js'

// Each provider's retention posture, as stated in the private-data notice (spec 8.3).
const RETENTION: Record<JevProvider['name'], string> = {
  openrouter: 'zero-data-retention routing was requested via provider preferences',
  typesafe: 'TypeSafe offers no per-request retention control, so retention follows TypeSafe terms',
}

const SENT_DATA = {
  pr: 'comment text, code hunks and the PR title',
  findings: 'finding text, code hunks and the title',
}

export type NoticeSubject = keyof typeof SENT_DATA

export function sentNotice(subject: NoticeSubject, provider: JevProvider): string {
  return `Sent ${SENT_DATA[subject]} to ${destination(provider)}; ${RETENTION[provider.name]}`
}

export function dryRunNotice(subject: NoticeSubject, provider: JevProvider): string {
  return `Would send ${SENT_DATA[subject]} to ${destination(provider)}; nothing was sent`
}

function destination(provider: JevProvider): string {
  return `${provider.name} (${provider.model})`
}

// Private repositories need an opt-in before anything is sent (spec 8.3).
export function assertPrivateAllowed(input: {
  repository: string
  isPrivate: boolean
  allowPrivateFlag: boolean
  allowList: string[]
  provider: JevProvider
}): void {
  if (!input.isPrivate || input.allowPrivateFlag) return
  const repository = input.repository.toLowerCase()
  if (input.allowList.some((entry) => entry === '*' || entry.toLowerCase() === repository)) return
  throw new QuietReviewError(
    'PRIVATE_REPO_NOT_ALLOWED',
    `${input.repository} is private; scoring it would send its review comments and code to ${destination(input.provider)}`,
    [
      'Run the command again with `--allow-private` to score this repository once',
      `Or add "${input.repository}" to \`allow_private\` in the user config to allow it standing`,
    ],
  )
}
