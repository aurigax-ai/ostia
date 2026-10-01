import { describe, expect, it } from 'vitest'
import { diffSummary } from './chatDiff'

describe('diffSummary', () => {
  it('has no lines for identical text', () => {
    expect(diffSummary('a\n', 'a\n')).toEqual({ lines: [], added: 0, removed: 0 })
  })

  it('counts added and removed lines and keeps context around each hunk', () => {
    const summary = diffSummary('one\ntwo\nthree\n', 'one\n2\nthree\nfour\n')
    expect(summary.added).toBe(2)
    expect(summary.removed).toBe(1)
    expect(summary.lines.map((l) => l.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx', 'add'])
    expect(summary.lines[2].text).toBe('-two')
  })

  it('shows a new file as additions only', () => {
    expect(diffSummary('', 'new\n').lines.map((l) => l.kind)).toEqual(['hunk', 'add'])
  })
})
