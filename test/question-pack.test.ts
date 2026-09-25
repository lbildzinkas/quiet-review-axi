import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTEXT_PACK, QUESTION_PACK_VERSION } from '../src/core/questions.js'

// Structure only: the pack's wording is judged by the replay, never by unit tests.
const pack = JSON.parse(
  readFileSync(new URL('../src/core/question-pack.json', import.meta.url), 'utf8'),
)

function placeholdersIn(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/\{[a-z_]+\}/g)].map((match) => match[0])
}

describe('question pack', () => {
  it('is versioned, and the tool reports that version', () => {
    expect(pack.version).toMatch(/^v\d+\.\d+$/)
    expect(QUESTION_PACK_VERSION).toBe(pack.version)
  })

  it('holds exactly the four question templates', () => {
    expect(Object.keys(pack.questions).sort()).toEqual(['act', 'cat', 'dup', 'sev'])
  })

  it('asks worth-acting-on as a Noul with both criteria', () => {
    expect(pack.questions.act.type).toBe('noul')
    expect(Object.keys(pack.questions.act.criteria).sort()).toEqual(['false', 'true'])
  })

  it('offers the eleven categories, including other', () => {
    expect(pack.questions.cat.type).toBe('choice')
    expect(Object.keys(pack.questions.cat.criteria)).toEqual([
      'bug',
      'security',
      'performance',
      'style',
      'docs',
      'nit',
      'wrong',
      'test_gap',
      'question',
      'summary_or_praise',
      'other',
    ])
  })

  it('describes severity as five ordered Score levels', () => {
    expect(pack.questions.sev.type).toBe('score')
    expect(pack.questions.sev.criteria).toHaveLength(5)
  })

  it('templates the duplicate question with a candidate option and a none option', () => {
    expect(pack.questions.dup.type).toBe('choice')
    expect(placeholdersIn(pack.questions.dup.candidate)).toEqual(['{candidate}'])
    expect(pack.questions.dup.none.length).toBeGreaterThan(0)
  })

  it('points every question at its own item and uses no unknown placeholder', () => {
    for (const [name, template] of Object.entries(pack.questions)) {
      const placeholders = new Set(placeholdersIn(template))
      expect(placeholders.has('{item}'), name).toBe(true)
      for (const placeholder of placeholders)
        expect(Object.keys(pack.placeholders)).toContain(placeholder)
    }
  })
})

describe('context question pack', () => {
  const contextPack = JSON.parse(
    readFileSync(new URL('../src/core/question-pack-context.json', import.meta.url), 'utf8'),
  )

  it('is versioned apart from the built-in pack, and loads', () => {
    expect(contextPack.version).not.toBe(pack.version)
    expect(CONTEXT_PACK.version).toBe(contextPack.version)
  })

  it("keeps the built-in pack's category, severity and duplicate questions", () => {
    for (const name of ['cat', 'sev', 'dup'])
      expect(contextPack.questions[name], name).toEqual(pack.questions[name])
  })

  it('points the worth-acting-on question at every context block by a bare state path', () => {
    expect(contextPack.questions.act.instructions).toMatchObject({
      review_comment: '`comments.{item}.comment`',
      code_under_review: '`comments.{item}.code`',
      rest_of_hunk: '`comments.{item}.hunk_rest`',
      surrounding_code: '`comments.{item}.file`',
      pull_request_description: '`pr.description`',
      linked_issue: '`pr.linked_issue`',
    })
  })
})
