import type { CompareFile } from './github.js'

export type Label = 'real' | 'noise' | 'excluded'

// Everything the label rules read, recorded from GitHub at build time (spec 10.5).
export interface Evidence {
  from: string
  to: string
  // The commented line range on the new side of the diff at `from`, before widening.
  anchor: { start: number; end: number } | null
  // The comment's file in the comparison from `from` to `to`; null when the file is unchanged.
  file: CompareFile | null
}

export interface LabelResult {
  label: Label
  reason: string | null
  changed: boolean
}

const ANCHOR_WIDENING = 2

export function labelComment(evidence: Evidence): LabelResult {
  const changed =
    evidence.anchor !== null && isChangedAt(evidence.file?.patch ?? '', evidence.anchor)
  return { label: changed ? 'real' : 'noise', reason: null, changed }
}

// `changed` (spec 10.5): a removed or modified line of the `from` side falls inside the anchor
// widened by 2 lines each way, or lines were inserted directly next to it.
export function isChangedAt(patch: string, anchor: { start: number; end: number }): boolean {
  const start = anchor.start - ANCHOR_WIDENING
  const end = anchor.end + ANCHOR_WIDENING
  let oldLine = 0
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/)
    if (header) {
      // A hunk with no old lines (`-10,0`) inserts after old line 10, before line 11.
      oldLine = Number(header[1]) + (header[2] === '0' ? 1 : 0)
      continue
    }
    if (line.startsWith('-')) {
      if (oldLine >= start && oldLine <= end) return true
      oldLine++
    } else if (line.startsWith('+')) {
      // An insertion sits just before old line `oldLine`.
      if (oldLine >= start && oldLine <= end + 1) return true
    } else if (!line.startsWith('\\')) oldLine++
  }
  return false
}
