import { describe, expect, it } from 'vitest'
import { languageForPath } from './editorLanguages'

describe('languageForPath', () => {
  it('names the editor language by file extension, whatever its case', () => {
    expect(languageForPath('/p/a.ts')).toBe('typescript')
    expect(languageForPath('/p/App.TSX')).toBe('typescript')
    expect(languageForPath('/p/main.rs')).toBe('rust')
    expect(languageForPath('/p/x.hpp')).toBe('cpp')
    expect(languageForPath('/p/types.pyi')).toBe('python')
  })

  it('falls back to plain text for an unknown or missing extension', () => {
    expect(languageForPath('/p/Makefile')).toBe('plaintext')
    expect(languageForPath('/p.d/notes')).toBe('plaintext')
    expect(languageForPath('/p/a.unknown')).toBe('plaintext')
    expect(languageForPath('/p/a.constructor')).toBe('plaintext')
  })
})
