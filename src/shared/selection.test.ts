import { describe, expect, it } from 'vitest'
import {
  SELECTION_TEXT_MAX,
  type SelectionCapture,
  isPng,
  normalizeSelection,
  renderSelectionReport,
  selectionLabel,
} from './selection'

const AT = new Date('2026-09-29T10:00:00.000Z')

describe('normalizeSelection', () => {
  it('keeps a well-formed text capture', () => {
    const capture = {
      kind: 'text',
      file: '/w/a.ts',
      view: 'source',
      range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 },
      text: 'hello',
    }
    expect(normalizeSelection(capture)).toEqual(capture)
  })

  it('drops columns unless both are valid', () => {
    const res = normalizeSelection({
      kind: 'text',
      file: '/w/a.md',
      view: 'preview',
      range: { startLine: 4, endLine: 6, startColumn: 2 },
      text: 'x',
    })
    expect(res).toMatchObject({ range: { startLine: 4, endLine: 6 } })
    expect(res?.kind === 'text' && res.range.startColumn).toBeFalsy()
  })

  it('truncates very long selected text', () => {
    const res = normalizeSelection({
      kind: 'pdf-text',
      file: '/w/a.pdf',
      firstPage: 1,
      lastPage: 1,
      text: 'y'.repeat(SELECTION_TEXT_MAX + 10),
    })
    expect(res?.kind === 'pdf-text' && res.text.length).toBe(SELECTION_TEXT_MAX)
  })

  it('rejects relative paths, empty text, inverted ranges and unknown kinds', () => {
    const range = { startLine: 1, endLine: 1 }
    expect(
      normalizeSelection({ kind: 'text', file: 'a.ts', view: 'source', range, text: 'x' }),
    ).toBeNull()
    expect(
      normalizeSelection({ kind: 'text', file: '/a.ts', view: 'source', range, text: '' }),
    ).toBeNull()
    expect(
      normalizeSelection({
        kind: 'text',
        file: '/a.ts',
        view: 'source',
        range: { startLine: 5, endLine: 2 },
        text: 'x',
      }),
    ).toBeNull()
    expect(normalizeSelection({ kind: 'video', file: '/a.mp4' })).toBeNull()
    expect(normalizeSelection(null)).toBeNull()
  })

  it('accepts a whole-image capture and rejects a malformed region', () => {
    expect(
      normalizeSelection({
        kind: 'image',
        file: '/a.png',
        imageWidth: 10,
        imageHeight: 10,
        region: null,
      }),
    ).toMatchObject({ region: null })
    expect(
      normalizeSelection({
        kind: 'image',
        file: '/a.png',
        imageWidth: 10,
        imageHeight: 10,
        region: { x: -1, y: 0, width: 4, height: 4 },
      }),
    ).toBeNull()
  })
})

describe('selectionLabel', () => {
  it('names the file with its line, page or region', () => {
    const text: SelectionCapture = {
      kind: 'text',
      file: '/w/src/a.ts',
      view: 'source',
      range: { startLine: 3, startColumn: 1, endLine: 5, endColumn: 2 },
      text: 'x',
    }
    expect(selectionLabel(text)).toBe('a.ts:3:1-5:2')
    expect(selectionLabel({ ...text, view: 'preview', range: { startLine: 7, endLine: 7 } })).toBe(
      'a.ts:7',
    )
    expect(
      selectionLabel({ kind: 'pdf-text', file: '/w/d.pdf', firstPage: 2, lastPage: 3, text: 'x' }),
    ).toBe('d.pdf, pages 2-3')
    expect(
      selectionLabel({
        kind: 'image',
        file: '/w/i.png',
        imageWidth: 9,
        imageHeight: 9,
        region: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toBe('i.png (x 1, y 2, 3 × 4)')
  })
})

describe('renderSelectionReport', () => {
  it('fences selected text with a longer fence when it contains backticks', () => {
    const md = renderSelectionReport(
      {
        kind: 'text',
        file: '/w/README.md',
        view: 'preview',
        range: { startLine: 1, endLine: 3 },
        text: 'use ```code```',
      },
      '',
      null,
      AT,
    )
    expect(md).toContain('# Text selection: README.md:1-3')
    expect(md).toContain('(no note)')
    expect(md).toContain(
      '- Lines: 1-3 (source lines of the block selected in the Markdown preview)',
    )
    expect(md).toContain('````\nuse ```code```\n````')
  })

  it('describes a PDF page region in points with its snapshot path', () => {
    const md = renderSelectionReport(
      {
        kind: 'pdf-region',
        file: '/w/d.pdf',
        page: 2,
        pageWidth: 612,
        pageHeight: 792,
        region: { x: 72, y: 100, width: 200, height: 50 },
      },
      'fix this chart',
      '/tmp/pine-reports-1/selection-1.png',
      AT,
    )
    expect(md).toContain('# PDF page region: d.pdf, page 2 (x 72, y 100, 200 × 50)')
    expect(md).toContain('- Page: 2 (1-based), 612 × 792 pt')
    expect(md).toContain('- Region: x 72, y 100, 200 × 50 (PDF points, origin top-left)')
    expect(md).toContain('- Snapshot: /tmp/pine-reports-1/selection-1.png')
    expect(md).not.toContain('## Selected text')
  })

  it('lists the page numbers of a PDF text selection', () => {
    const md = renderSelectionReport(
      { kind: 'pdf-text', file: '/w/d.pdf', firstPage: 4, lastPage: 4, text: 'Total: 42' },
      '',
      null,
      AT,
    )
    expect(md).toContain('- Pages: 4 (1-based)')
    expect(md).toContain('```\nTotal: 42\n```')
  })
})

describe('isPng', () => {
  it('checks the 8-byte PNG signature', () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true)
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false)
  })
})
