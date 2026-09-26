// An item is a review comment or a finding, normalized for scoring (spec 3).
export interface Item {
  // Key used inside the Jev state and question ids: c1, c2, ... in item order.
  key: string
  // Id shown in output: the same cN for PR comments, the finding's own id for findings.
  id: string
  body: string
  code: string
  context: 'hunk' | 'file' | 'none'
  path: string | null
  line: number | null
  lines: string | null
  author: string | null
  url: string | null
  // Context blocks (the replay's context ablation): the commented file around the comment at
  // the comment's commit, and the rest of the diff hunk after the commented line.
  file?: string
  hunkRest?: string
}

const MAX_BODY_CHARACTERS = 2000
const HUNK_TAIL_LINES = 25

// Footer lines bots append to every comment. Extend this list with recorded examples.
const FOOTER_LINES = [/^\s*_?Copilot uses AI\. Check for mistakes\._?\s*$/i]

// Body cleaning (spec 5.3): a pure function, so the same comment always yields the same state.
// Longer texts, such as a pull request's description in a context block, pass their own cut.
export function cleanBody(raw: string, maxCharacters = MAX_BODY_CHARACTERS): string {
  let body = raw.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '')
  body = removeDetailsBlocks(body)
    .replace(/!\[[^\]]*\]\([^)]*\)[ \t]*/g, '')
    .replace(/<img\b[^>]*>[ \t]*/gi, '')
  const lines = body
    .split('\n')
    .filter((line) => !FOOTER_LINES.some((pattern) => pattern.test(line)))
    .map((line) => line.trimEnd())
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd()
    .slice(0, maxCharacters)
}

// Removes innermost <details> blocks first, until none are left.
function removeDetailsBlocks(body: string): string {
  const innermost = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi
  let current = body
  for (;;) {
    const next = current.replace(innermost, '')
    if (next === current) return current
    current = next
  }
}

// A review hunk ends at the commented line, so its tail is the relevant code (spec 5.3).
export function hunkTail(hunk: string): string {
  return hunk.replace(/\r\n?/g, '\n').split('\n').slice(-HUNK_TAIL_LINES).join('\n')
}
