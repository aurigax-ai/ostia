import { describe, expect, it } from 'vitest'
import { fileViewKind, imageMimeType } from './fileKinds'

describe('fileViewKind', () => {
  it('opens every supported image extension in the image viewer, case-insensitively', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'PNG']) {
      expect(fileViewKind(`/w/pic.${ext}`)).toBe('image')
    }
  })

  it('opens PDFs in the PDF viewer and everything else as text', () => {
    expect(fileViewKind('/w/paper.PDF')).toBe('pdf')
    expect(fileViewKind('/w/a.ts')).toBe('text')
    expect(fileViewKind('/w/png')).toBe('text')
    expect(fileViewKind(undefined)).toBe('text')
  })
})

describe('imageMimeType', () => {
  it('maps extensions to the blob type the viewer needs', () => {
    expect(imageMimeType('/w/a.svg')).toBe('image/svg+xml')
    expect(imageMimeType('/w/a.jpg')).toBe('image/jpeg')
    expect(imageMimeType('/w/a.txt')).toBeNull()
  })
})
