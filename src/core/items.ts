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
}
