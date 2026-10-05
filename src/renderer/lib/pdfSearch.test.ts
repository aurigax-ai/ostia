import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDF_SEARCH_MAX_BYTES, clipLine, searchPdfs } from './pdfSearch'
import { textMatcher } from './textMatch'

const pages: Record<string, { str: string; hasEOL: boolean }[][]> = {
  '/r/a.pdf': [
    [{ str: 'first page', hasEOL: true }],
    [{ str: 'the needle is here', hasEOL: true }],
  ],
  '/r/b.pdf': [[{ str: 'nothing', hasEOL: true }]],
}

vi.mock('./pdf', () => ({
  openPdf: vi.fn(async (data: Uint8Array) => {
    const path = new TextDecoder().decode(data)
    const list = pages[path]
    return {
      numPages: list.length,
      getPage: async (n: number) => ({ getTextContent: async () => ({ items: list[n - 1] }) }),
      loadingTask: { destroy: vi.fn() },
    }
  }),
}))

const matcher = textMatcher('needle', { caseSensitive: false, wholeWord: false, regex: false })

describe('searchPdfs', () => {
  afterEach(() => vi.restoreAllMocks())

  it('finds text by page and skips files over the size cap', async () => {
    vi.mocked(window.ostia.fs.readBinary).mockImplementation(async (path) => ({
      ok: true,
      data: new TextEncoder().encode(path),
    }))
    const res = await searchPdfs(
      '/r',
      [
        { path: 'a.pdf', size: 10, mtimeMs: 1 },
        { path: 'b.pdf', size: 10, mtimeMs: 1 },
        { path: 'big.pdf', size: PDF_SEARCH_MAX_BYTES + 1, mtimeMs: 1 },
      ],
      matcher as NonNullable<typeof matcher>,
    )
    expect(res).toEqual({
      files: [
        {
          path: 'a.pdf',
          matches: [{ page: 2, text: 'the needle is here', ranges: [[4, 10]], query: 'needle' }],
        },
      ],
      skipped: 1,
    })
  })

  it('counts a file it cannot read as skipped', async () => {
    vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({ ok: false, error: 'denied' })
    const res = await searchPdfs(
      '/r',
      [{ path: 'gone.pdf', size: 10, mtimeMs: 2 }],
      matcher as NonNullable<typeof matcher>,
    )
    expect(res).toEqual({ files: [], skipped: 1 })
  })
})

describe('clipLine', () => {
  it('keeps a long line around its first match', () => {
    const line = `${'x'.repeat(1000)}needle${'y'.repeat(1000)}`
    const shown = clipLine(line, [[1000, 1006]])
    const [[from, to]] = shown.ranges
    expect(shown.text.slice(from, to)).toBe('needle')
    expect(shown.text.length).toBeLessThanOrEqual(240)
  })
})
