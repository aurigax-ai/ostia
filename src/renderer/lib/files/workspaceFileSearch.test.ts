import type { SearchOutcome } from '@shared/files/search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findWorkspaceLines, splitFilePosition } from './workspaceFileSearch'

afterEach(() => {
  vi.mocked(window.ostia.search.run).mockReset()
})

describe('splitFilePosition', () => {
  it('reads a line, or a line and a column, after the name', () => {
    expect(splitFilePosition('greet.ts:12')).toEqual({ name: 'greet.ts', line: 12 })
    expect(splitFilePosition('src/greet.ts:12:5')).toEqual({
      name: 'src/greet.ts',
      line: 12,
      column: 5,
    })
    expect(splitFilePosition(' greet:7: ')).toEqual({ name: 'greet', line: 7 })
  })

  it('leaves text without a position, or with one that points nowhere, as it was typed', () => {
    expect(splitFilePosition('greet.ts')).toEqual({ name: 'greet.ts' })
    expect(splitFilePosition('greet.ts:')).toEqual({ name: 'greet.ts:' })
    expect(splitFilePosition('greet.ts:0')).toEqual({ name: 'greet.ts:0' })
    expect(splitFilePosition('greet.ts:x')).toEqual({ name: 'greet.ts:x' })
    expect(splitFilePosition(':12')).toEqual({ name: ':12' })
    expect(splitFilePosition('greet.ts:12:0')).toEqual({ name: 'greet.ts', line: 12 })
  })
})

describe('findWorkspaceLines', () => {
  const found: SearchOutcome = {
    ok: true,
    results: {
      root: '/src/api',
      names: [],
      files: [
        {
          path: 'lib/a.ts',
          matches: [
            { line: 3, column: 9, text: '    const needle = 1', ranges: [[10, 16]] },
            { line: 8, column: 1, text: 'needle()', ranges: [[0, 6]] },
          ],
        },
        { path: 'b.md', matches: [{ line: 1, column: 5, text: 'the needle', ranges: [[4, 10]] }] },
      ],
      pdfs: [],
      matches: 3,
      truncated: true,
    },
  }

  it('asks the core search for lines only and flattens them in file order, trimmed', async () => {
    vi.mocked(window.ostia.search.run).mockResolvedValue(found)

    expect(await findWorkspaceLines('/src/api', 'needle', true)).toEqual({
      status: 'hits',
      root: '/src/api',
      more: true,
      lines: [
        { path: 'lib/a.ts', line: 3, column: 9, text: 'const needle = 1' },
        { path: 'lib/a.ts', line: 8, column: 1, text: 'needle()' },
        { path: 'b.md', line: 1, column: 5, text: 'the needle' },
      ],
    })
    expect(window.ostia.search.run).toHaveBeenCalledWith({
      root: '/src/api',
      text: 'needle',
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      includeIgnored: true,
      linesOnly: true,
    })
  })

  it('tells a cancelled search from a failed one', async () => {
    vi.mocked(window.ostia.search.run).mockResolvedValueOnce({
      ok: false,
      error: 'cancelled',
      message: '',
    })
    expect(await findWorkspaceLines('/src/api', 'needle', false)).toEqual({ status: 'cancelled' })
    vi.mocked(window.ostia.search.run).mockResolvedValueOnce({
      ok: false,
      error: 'rg-missing',
      message: '',
    })
    expect(await findWorkspaceLines('/src/api', 'needle', false)).toEqual({ status: 'failed' })
  })
})
