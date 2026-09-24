import { describe, expect, it } from 'vitest'
import { cleanBody, hunkTail } from '../src/core/items.js'

describe('body cleaning', () => {
  it('removes HTML comments, where bots hide metadata', () => {
    expect(cleanBody('Real issue.<!-- internal: fingerprint abc\nmore -->\nSecond line.')).toBe(
      'Real issue.\nSecond line.',
    )
  })

  it('removes details blocks, including nested ones', () => {
    const body = [
      'Null check missing.',
      '<details>',
      '<summary>Prompt for AI Agents</summary>',
      '<details><summary>inner</summary>text</details>',
      'Fix it like this',
      '</details>',
      'End.',
    ].join('\n')

    expect(cleanBody(body)).toBe('Null check missing.\n\nEnd.')
  })

  it('removes badge images', () => {
    expect(
      cleanBody(
        '![high](https://img.shields.io/badge/high-red) <img src="x.svg" alt="badge"/> Crash on empty list.',
      ),
    ).toBe('Crash on empty list.')
  })

  it('removes known bot footer lines', () => {
    expect(cleanBody('Off-by-one in the loop.\n\nCopilot uses AI. Check for mistakes.')).toBe(
      'Off-by-one in the loop.',
    )
  })

  it('keeps fenced suggestion blocks', () => {
    const body = 'Use const.\n```suggestion\nconst total = 0\n```'

    expect(cleanBody(body)).toBe(body)
  })

  it('normalizes line endings, trims trailing whitespace and collapses runs of blank lines', () => {
    expect(cleanBody('  First.  \r\nSecond.\t\r\n\r\n\r\n\r\nThird.\n\n')).toBe(
      '  First.\nSecond.\n\nThird.',
    )
  })

  it('cuts the body to 2,000 characters', () => {
    expect(cleanBody('a'.repeat(2500))).toHaveLength(2000)
  })
})

describe('hunk tail', () => {
  it('keeps the last 25 lines of a review hunk, which end at the commented line', () => {
    const hunk = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')

    expect(hunkTail(hunk).split('\n')).toEqual(
      Array.from({ length: 25 }, (_, index) => `line ${index + 16}`),
    )
  })
})
