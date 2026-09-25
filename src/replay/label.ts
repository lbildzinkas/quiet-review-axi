import { MAX_COMPARE_FILES, type CompareFile } from './github.js'

export type Label = 'real' | 'noise' | 'excluded'

// Everything the label rules read, recorded from GitHub at build time (spec 10.5).
export interface Evidence {
  from: string
  to: string
  // The commented line range on the new side of the diff at `from`, before widening.
  anchor: { start: number; end: number } | null
  // The comparison from `from` to `to`, or null when either commit cannot be fetched.
  compare: {
    merge_base: string
    files_listed: number
    // The comment's file, or null when the comparison does not list it (unchanged).
    file: CompareFile | null
  } | null
  // Lines of the comment's file at `from`, read when the file changed; null when unread.
  file_lines: number | null
  resolved: boolean
  replies: Reply[]
  // The PR's commits after the comment's commit, in order (label-rules-v2). Absent in
  // evidence recorded before label-rules-v2.
  commits_after?: LaterCommit[]
  // The login of the account that resolved the review thread, or null while unresolved
  // (label-rules-v2; GraphQL `resolvedBy`). Absent in evidence recorded before label-rules-v2.
  resolved_by?: string | null
  // Commits on the base branch within about 7 days after the merge that changed the
  // commented lines, by sha and subject (label-rules-v2; fixes from follow-up PRs).
  // Absent in evidence recorded before label-rules-v2.
  followups?: LaterCommit[]
}

// A commit of the pull request after the comment, by sha and subject (first line).
export interface LaterCommit {
  sha: string
  subject: string
}

export interface Reply {
  author: string
  is_bot: boolean
  body: string
}

export interface Signals {
  changed: boolean
  resolved: boolean
  agree: boolean
  disagree: boolean
  // The reviewing bot retracted its own finding (label-rules-v2).
  withdrawn: boolean
  // The reviewing bot resolved its own thread, and its resolve behaviour is trusted as a
  // fix (label-rules-v2, per-bot setting).
  resolved_by_bot: boolean
  // A commit after the comment repeats the comment heading's key terms (label-rules-v2).
  commit_match: boolean
  // A follow-up on the base branch changed the commented lines (label-rules-v2).
  followup_changed: boolean
}

export interface LabelResult {
  label: Label
  reason: string | null
  signals: Signals
}

const ANCHOR_WIDENING = 2
const MAX_CHANGED_SHARE = 0.5

// Reply patterns, fixed before the replay. Matched case-insensitively as whole words in
// replies from people (label-rules-v2); agent signature footers are stripped first.
const AGREE_PATTERNS = [
  /\bfixed\b/i,
  /\bdone\b/i,
  /\bgood catch\b/i,
  /\baddressed\b/i,
  /\bupdated\b/i,
  /\bthanks\b/i,
]
const DISAGREE_PATTERNS = [
  /\bnot an issue\b/i,
  /\bwon['’]t fix\b/i,
  /\bwontfix\b/i,
  /\bintentional\b/i,
  /\bby design\b/i,
  /\bfalse positive\b/i,
  /\bincorrect\b/i,
  /\bnot needed\b/i,
  /\bignore\b/i,
  /\bno code change needed\b/i,
  /\bnot actionable\b/i,
  /\bnot applicable\b/i,
  /\bdoes not apply\b/i,
  /\bworking as intended\b/i,
]
// How a reviewing bot retracts its own finding, matched in its replies only (label-rules-v2).
const WITHDRAWAL_PATTERNS = [
  /\bwithdraw\w*\b/i,
  /\bdoes not apply\b/i,
  /\bnot applicable\b/i,
  /\bfalse positive\b/i,
]

// The comment under test, as the label rules read it: the reviewing bot's login (whose
// replies can withdraw the finding) and the comment body (whose heading names the terms a
// fix commit's subject repeats).
export interface CommentUnderTest {
  bot: string
  body: string
}

const NO_COMMENT: CommentUnderTest = { bot: '', body: '' }

// The version of the automatic labelling rules (spec 10.5). The rules are pre-registered
// with a replay: a change is a new version, recorded in the manifest's label stage, and a
// replay labelled under another version is never relabelled in place (use a new replay
// name). label-rules-v1 labelled public-v1; label-rules-v2 revised the rules after the
// adjudication of public-v1's label check.
export const LABEL_RULES_VERSION = 'label-rules-v2'

// Per-bot resolve settings (label-rules-v2). What it means when a bot resolves the very
// thread it commented on differs per bot and was verified against the public-v1 data only
// for Cursor Bugbot: it resolves its own thread when a later commit fixes the issue. The
// other listed bots were only seen resolving together with a withdrawal, so their resolves
// alone are not trusted as fixes.
export const BOTS_WHOSE_SELF_RESOLVE_MEANS_FIXED: ReadonlySet<string> = new Set(['cursor[bot]'])

// The label rules of spec 10.5 (label-rules-v2), applied in order.
export function labelComment(
  evidence: Evidence,
  comment: CommentUnderTest = NO_COMMENT,
): LabelResult {
  const signals = signalsOf(evidence, comment)
  const result = (label: Label, reason: string | null = null) => ({ label, reason, signals })
  const unmapped = unmappedReason(evidence)
  if (unmapped !== null) return result('excluded', unmapped)
  if (isRewrite(evidence)) return result('excluded', 'rewrite')
  if (signals.agree && signals.disagree) return result('excluded', 'conflicting replies')
  // A withdrawal or a human disagreement overrides a coincidental change at the anchor.
  if (signals.withdrawn) return result('noise')
  if (signals.disagree) return result('noise')
  if (signals.changed) return result('real')
  if (signals.agree && signals.resolved) return result('real')
  if (signals.resolved_by_bot) return result('real')
  if (signals.commit_match) return result('real')
  if (signals.followup_changed) return result('real')
  // A comment on the PR's final head commit could not have been acted on inside the PR:
  // with no reply, resolve, commit or follow-up evidence, the rules can only guess, so the
  // item is dropped from the dataset instead (label-rules-v2).
  if (evidence.from === evidence.to) return result('excluded', 'no commits after comment')
  return result('noise')
}

function signalsOf(evidence: Evidence, comment: CommentUnderTest): Signals {
  let agree = false
  let disagree = false
  let withdrawn = false
  const later = (evidence.commits_after ?? []).map((commit) => commit.sha.toLowerCase())
  // A commit reference (7-40 hex characters with a digit, bare or inside a commit link)
  // counts only when it names one of the PR's commits after the comment.
  const namesLaterCommit = (body: string) =>
    [...body.matchAll(/\b[0-9a-f]{7,40}\b/gi)].some(
      (match) => /\d/.test(match[0]) && later.some((sha) => sha.startsWith(match[0].toLowerCase())),
    )
  for (const reply of evidence.replies) {
    const body = stripSignatureFooters(reply.body)
    // One reply is read as one voice: a reply that disputes the comment is a disagreement,
    // even when it also names the commit that pinned the disputed behaviour.
    if (reply.is_bot) {
      if (reply.author === comment.bot && matchesAny(body, WITHDRAWAL_PATTERNS)) withdrawn = true
      else if (namesLaterCommit(body)) agree = true
      continue
    }
    if (matchesAny(body, DISAGREE_PATTERNS)) disagree = true
    else if (matchesAny(body, AGREE_PATTERNS) || namesLaterCommit(body)) agree = true
  }
  const patch = evidence.compare?.file?.patch
  return {
    changed: evidence.anchor !== null && patch !== undefined && isChangedAt(patch, evidence.anchor),
    resolved: evidence.resolved,
    agree,
    disagree,
    withdrawn,
    resolved_by_bot:
      evidence.resolved &&
      evidence.resolved_by === comment.bot &&
      BOTS_WHOSE_SELF_RESOLVE_MEANS_FIXED.has(comment.bot),
    commit_match: commitMatchesHeading(comment.body, evidence.commits_after ?? []),
    followup_changed: (evidence.followups ?? []).length > 0,
  }
}

// A commit after the comment fixes the issue elsewhere in the PR when its subject repeats
// the comment heading's key terms (label-rules-v2): at least two terms of four or more
// characters, or one distinctive term of eight or more. The heading is the first markdown
// heading or bold title line, the formats CodeRabbit, Cursor Bugbot and Greptile use.
const MIN_SHARED_TERMS = 2
const SHORT_TERM_CHARACTERS = 4
const DISTINCTIVE_TERM_CHARACTERS = 8

export function commitMatchesHeading(body: string, commits: LaterCommit[]): boolean {
  const heading = headingOf(body)
  if (heading === null) return false
  const terms = [...heading.toLowerCase().matchAll(/\w+/g)]
    .map((match) => match[0])
    .filter((term) => term.length >= SHORT_TERM_CHARACTERS)
  if (terms.length === 0) return false
  return commits.some((commit) => {
    const subject = commit.subject.toLowerCase()
    const shared = terms.filter((term) => subject.includes(term))
    return shared.length >= MIN_SHARED_TERMS || shared.some(isDistinctive)
  })
}

function isDistinctive(term: string): boolean {
  return term.length >= DISTINCTIVE_TERM_CHARACTERS
}

function headingOf(body: string): string | null {
  for (const line of body.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading?.[1] !== undefined) return heading[1]
    // Greptile prefixes its bold title with an anchor placeholder.
    const bold = line.match(/^(?:<a\s[^>]*><\/a>\s*)?\*\*(.+?)\*\*\s*$/)
    if (bold?.[1] !== undefined) return bold[1]
  }
  return null
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

// Agent signature footers ("Co-Authored-By:", "Addressed by [Claude Code]", "Written by an
// agent"), ignored when reading replies: they say which agent posted the reply, not that the
// comment was acted on. Matched on the line's text after any leading decoration.
const FOOTER_PREFIXES = [
  'co-authored-by:',
  'generated by',
  'generated with',
  'addressed by',
  'written by',
]

function stripSignatureFooters(body: string): string {
  return body
    .split('\n')
    .filter((line) => {
      const core = line.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
      return !FOOTER_PREFIXES.some((prefix) => core.startsWith(prefix))
    })
    .join('\n')
}

// Rule 1: `from` or `to` cannot be fetched, the anchor cannot be mapped, or the file was
// deleted or renamed after the comment.
function unmappedReason(evidence: Evidence): string | null {
  const { compare } = evidence
  if (compare === null) return 'commit unavailable'
  if (compare.merge_base !== evidence.from) return 'history rewritten'
  if (evidence.anchor === null) return 'anchor unmapped'
  const { file } = compare
  if (file === null) return compare.files_listed >= MAX_COMPARE_FILES ? 'diff unavailable' : null
  if (file.status === 'removed') return 'file deleted'
  if (file.status === 'renamed') return 'file renamed'
  if (file.patch === undefined) return 'diff unavailable'
  if (file.deletions > 0 && evidence.file_lines === null) return 'file unavailable'
  return null
}

// Rule 2: more than half of the file's lines at `from` changed before merge.
function isRewrite(evidence: Evidence): boolean {
  const file = evidence.compare?.file
  if (!file || evidence.file_lines === null || evidence.file_lines === 0) return false
  return file.deletions / evidence.file_lines > MAX_CHANGED_SHARE
}

// `changed` (spec 10.5): a removed or modified line of the `from` side falls inside the anchor
// widened by 2 lines each way, or lines were inserted directly next to it.
export function isChangedAt(patch: string, anchor: { start: number; end: number }): boolean {
  const start = anchor.start - ANCHOR_WIDENING
  const end = anchor.end + ANCHOR_WIDENING
  let oldLine = 0
  // Whether the current run of changed lines began with removals: its `+` lines replace
  // them, so only the removals locate that change.
  let isReplacing = false
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/)
    if (header) {
      // A hunk with no old lines (`-10,0`) inserts after old line 10, before line 11.
      oldLine = Number(header[1]) + (header[2] === '0' ? 1 : 0)
      isReplacing = false
      continue
    }
    if (line.startsWith('-')) {
      if (oldLine >= start && oldLine <= end) return true
      oldLine++
      isReplacing = true
    } else if (line.startsWith('+')) {
      // A pure insertion sits just before old line `oldLine`.
      if (!isReplacing && oldLine >= start && oldLine <= end + 1) return true
    } else if (!line.startsWith('\\')) {
      oldLine++
      isReplacing = false
    }
  }
  return false
}
