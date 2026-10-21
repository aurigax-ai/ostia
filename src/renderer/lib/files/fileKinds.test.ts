import { describe, expect, it } from 'vitest'
import { fileViewKind } from './fileKinds'

describe('fileViewKind', () => {
  it('opens PDFs in the PDF viewer and everything else as text', () => {
    expect(fileViewKind('/w/paper.PDF')).toBe('pdf')
    expect(fileViewKind('/w/a.ts')).toBe('text')
    expect(fileViewKind('/w/pic.png')).toBe('text')
    expect(fileViewKind('/w/png')).toBe('text')
    expect(fileViewKind(undefined)).toBe('text')
  })
})
