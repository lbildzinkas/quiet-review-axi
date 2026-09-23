import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Item } from '../core/items.js'

export interface FindingsInput {
  title?: string
  items: Item[]
}

interface RawFinding {
  id: string
  body: string
  path?: string
  line?: number
  hunk?: string
  author?: string
}

// Parses the generic findings format (spec 4.5).
export async function loadFindings(options: { file: string; cwd: string }): Promise<FindingsInput> {
  const text = await readFile(resolve(options.cwd, options.file), 'utf8')
  const document = JSON.parse(text) as { title?: string; findings: RawFinding[] }
  const items = document.findings.map((finding, index): Item => ({
    key: `c${index + 1}`,
    id: finding.id,
    body: finding.body,
    code: finding.hunk ?? '',
    context: finding.hunk === undefined ? 'none' : 'hunk',
    path: finding.path ?? null,
    line: finding.line ?? null,
    lines: finding.line === undefined ? null : String(finding.line),
    author: finding.author ?? null,
    url: null,
  }))
  return { title: document.title, items }
}
