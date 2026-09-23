import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { cleanBody, hunkTail, type Item } from '../core/items.js'
import { validationError } from '../errors.js'

export interface FindingsInput {
  title?: string
  items: Item[]
  warnings: string[]
}

export interface LoadFindingsOptions {
  // A path, or `-` for stdin.
  file: string
  cwd: string
  repoRoot?: string
  readStdin: () => Promise<string>
}

const DOCUMENT_FIELDS = new Set(['title', 'findings'])
const FINDING_FIELDS = new Set(['id', 'body', 'path', 'line', 'hunk', 'author'])
// Context read around `line` when a finding has no hunk (spec 4.5).
const LINES_BEFORE = 15
const LINES_AFTER = 5

// Parses and validates the generic findings format (spec 4.5). Items are keyed c1, c2, ...
// in file order; the finding's own id is only shown in output, never sent.
export async function loadFindings(options: LoadFindingsOptions): Promise<FindingsInput> {
  const text = options.file === '-' ? await options.readStdin() : await readFindingsFile(options)
  const document = parseDocument(text)
  const findings = document.findings
  const unknown = new Set(Object.keys(document).filter((key) => !DOCUMENT_FIELDS.has(key)))
  const seen = new Set<string>()
  const root = resolve(options.cwd, options.repoRoot ?? '.')
  const items: Item[] = []
  for (const [index, finding] of findings.entries()) {
    const at = `findings[${index}]`
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding))
      throw validationError(`${at} must be an object`)
    const record = finding as Record<string, unknown>
    for (const key of Object.keys(record))
      if (!FINDING_FIELDS.has(key)) unknown.add(`findings[].${key}`)
    const id = requireString(record.id, `${at}.id`)
    const body = requireString(record.body, `${at}.body`)
    if (seen.has(id))
      throw validationError(`${at}.id "${id}" is used by an earlier finding; ids must be unique`)
    seen.add(id)
    const path = optionalString(record.path, `${at}.path`)
    const line = optionalLine(record.line, `${at}.line`)
    const hunk = optionalString(record.hunk, `${at}.hunk`)
    const author = optionalString(record.author, `${at}.author`)
    const fromFile =
      hunk === null && path !== null && line !== null ? await readContext(root, path, line) : null
    items.push({
      key: `c${index + 1}`,
      id,
      body: cleanBody(body),
      code: hunk !== null ? hunkTail(hunk) : (fromFile ?? ''),
      context: hunk !== null ? 'hunk' : fromFile !== null ? 'file' : 'none',
      path,
      line,
      lines: line === null ? null : String(line),
      author,
      url: null,
    })
  }
  const warnings =
    unknown.size === 0 ? [] : [`unknown fields ignored: ${[...unknown].sort().join(', ')}`]
  const title = optionalString(document.title, 'title')
  return { ...(title === null ? {} : { title }), items, warnings }
}

async function readFindingsFile(options: LoadFindingsOptions): Promise<string> {
  try {
    return await readFile(resolve(options.cwd, options.file), 'utf8')
  } catch {
    throw validationError(`Cannot read the findings file ${options.file}`)
  }
}

function parseDocument(text: string): Record<string, unknown> & { findings: unknown[] } {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw validationError('The findings file is not valid JSON')
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document))
    throw validationError('The findings file must be a JSON object with a `findings` array')
  const record = document as Record<string, unknown>
  if (!Array.isArray(record.findings))
    throw validationError('The findings file needs a `findings` array')
  return record as Record<string, unknown> & { findings: unknown[] }
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw validationError(`${at} is required and must be a non-empty string`)
  return value
}

function optionalString(value: unknown, at: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw validationError(`${at} must be a string`)
  return value
}

function optionalLine(value: unknown, at: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || (value as number) < 1)
    throw validationError(`${at} must be a 1-based line number`)
  return value as number
}

// Reads lines line-15 .. line+5 of a file inside the repository root. Paths that resolve
// outside the root, and unreadable files, give no context.
async function readContext(root: string, path: string, line: number): Promise<string | null> {
  try {
    const realRoot = await realpath(root)
    const file = await realpath(resolve(realRoot, path))
    const inside = relative(realRoot, file)
    if (inside.startsWith('..') || isAbsolute(inside)) return null
    const lines = (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n').split('\n')
    if (line > lines.length) return null
    return lines.slice(Math.max(0, line - 1 - LINES_BEFORE), line + LINES_AFTER).join('\n')
  } catch {
    return null
  }
}
