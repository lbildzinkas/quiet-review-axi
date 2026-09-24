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
}

export interface LabelResult {
  label: Label
  reason: string | null
  signals: Signals
}

const ANCHOR_WIDENING = 2
const MAX_CHANGED_SHARE = 0.5

// Reply patterns (spec 10.5), fixed before the replay. Matched case-insensitively as whole
// words in replies from people; a commit SHA (7-40 hex characters with a digit, bare or in a
// commit link) also counts as agreement.
const AGREE_PATTERNS = [
  /\bfixed\b/i,
  /\bdone\b/i,
  /\bgood catch\b/i,
  /\baddressed\b/i,
  /\bupdated\b/i,
  /\bthanks\b/i,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i,
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
]

// The label rules of spec 10.5, applied in order.
export function labelComment(evidence: Evidence): LabelResult {
  const signals = signalsOf(evidence)
  const result = (label: Label, reason: string | null = null) => ({ label, reason, signals })
  const unmapped = unmappedReason(evidence)
  if (unmapped !== null) return result('excluded', unmapped)
  if (isRewrite(evidence)) return result('excluded', 'rewrite')
  if (signals.agree && signals.disagree) return result('excluded', 'conflicting replies')
  if (signals.changed && signals.disagree) return result('excluded', 'conflicting signals')
  if (signals.changed) return result('real')
  if (signals.agree && signals.resolved) return result('real')
  return result('noise')
}

function signalsOf(evidence: Evidence): Signals {
  const people = evidence.replies.filter((reply) => !reply.is_bot).map((reply) => reply.body)
  const matchesAny = (patterns: RegExp[]) =>
    people.some((body) => patterns.some((pattern) => pattern.test(body)))
  const patch = evidence.compare?.file?.patch
  return {
    changed: evidence.anchor !== null && patch !== undefined && isChangedAt(patch, evidence.anchor),
    resolved: evidence.resolved,
    agree: matchesAny(AGREE_PATTERNS),
    disagree: matchesAny(DISAGREE_PATTERNS),
  }
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
