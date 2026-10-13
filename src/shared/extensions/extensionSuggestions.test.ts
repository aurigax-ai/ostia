import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTENSION_SUGGESTIONS, filesLabel, suggestedExtension } from './extensionSuggestions'

describe('suggestedExtension', () => {
  it('looks at the whole file name first, then at the suffix', () => {
    const table = {
      'by-suffix': { names: [], suffixes: ['mod', 'rs'] },
      'by-name': { names: ['go.mod', 'Makefile'], suffixes: [] },
    }
    expect(suggestedExtension('/p/go.mod', table)).toEqual({ extId: 'by-name', files: 'go.mod' })
    expect(suggestedExtension('/p/other.mod', table)).toEqual({ extId: 'by-suffix', files: '.mod' })
    expect(suggestedExtension('/p/Makefile', table)).toEqual({
      extId: 'by-name',
      files: 'Makefile',
    })
    expect(suggestedExtension('/p/MAIN.RS', table)).toEqual({ extId: 'by-suffix', files: '.rs' })
  })

  it('suggests nothing for a file no entry names', () => {
    expect(suggestedExtension('/p/notes.txt')).toBeNull()
    expect(suggestedExtension('/p/README')).toBeNull()
    expect(suggestedExtension('/p/.rs')).toBeNull()
    expect(suggestedExtension('/p.rs/file')).toBeNull()
  })

  it('names the published language extension for the files it serves', () => {
    const suggested = (name: string): string | undefined => suggestedExtension(`/p/${name}`)?.extId
    expect(suggested('a.ts')).toBe('lsp-typescript')
    expect(suggested('a.jsx')).toBe('lsp-typescript')
    expect(suggested('a.py')).toBe('lsp-pyright')
    expect(suggested('a.rs')).toBe('lsp-rust-analyzer')
    expect(suggested('a.go')).toBe('lsp-gopls')
    expect(suggested('go.mod')).toBe('lsp-gopls')
    expect(suggested('a.hpp')).toBe('lsp-clangd')
    expect(suggested('a.lua')).toBe('lsp-lua')
  })

  it('labels the kind of file a notice talks about', () => {
    expect(filesLabel('/p/a.RS')).toBe('.rs')
    expect(filesLabel('/p/Dockerfile')).toBe('Dockerfile')
  })
})

describe('EXTENSION_SUGGESTIONS', () => {
  const extensions = readdirSync(join(__dirname, '..', '..', 'extensions')).filter((id) =>
    id.startsWith('lsp-'),
  )

  it('has an entry for every language server extension in the source tree, and no other', () => {
    expect(extensions.length).toBeGreaterThan(0)
    expect(Object.keys(EXTENSION_SUGGESTIONS).sort()).toEqual([...extensions].sort())
  })

  it('names each suffix and file name once', () => {
    const seen = Object.values(EXTENSION_SUGGESTIONS).flatMap((rule) => [
      ...rule.names,
      ...rule.suffixes.map((suffix) => `.${suffix}`),
    ])
    expect(new Set(seen).size).toBe(seen.length)
    for (const rule of Object.values(EXTENSION_SUGGESTIONS)) {
      expect(rule.names.length + rule.suffixes.length).toBeGreaterThan(0)
      for (const suffix of rule.suffixes) expect(suffix).toMatch(/^[a-z0-9]+$/)
    }
  })
})
