import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type EditorLanguageContribution, GRAMMAR_FILE_MAX_BYTES } from '../shared/editorLanguages'
import { type EditorLanguageSource, loadEditorLanguages, readGrammar } from './editorLanguages'

let root: string
let dir: string

const GRAMMAR = { tokenizer: { root: [['[a-z]+', 'identifier']] } }

function contribution(extra: Partial<EditorLanguageContribution> = {}): EditorLanguageContribution {
  return {
    id: 'gleam',
    name: 'Gleam',
    extensions: ['.gleam'],
    filenames: [],
    configuration: { lineComment: '//' },
    grammar: 'gleam.monarch.json',
    ...extra,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-editor-lang-'))
  dir = join(root, 'ext')
  mkdirSync(dir)
  writeFileSync(join(dir, 'gleam.monarch.json'), JSON.stringify(GRAMMAR))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readGrammar', () => {
  it('reads a grammar file inside the extension', () => {
    expect(readGrammar(dir, 'gleam.monarch.json')).toEqual({ ok: true, grammar: GRAMMAR })
  })

  it('refuses a link, a file outside the extension, an oversized file and bad JSON', () => {
    writeFileSync(join(root, 'outside.json'), JSON.stringify(GRAMMAR))
    symlinkSync(join(root, 'outside.json'), join(dir, 'link.json'))
    writeFileSync(join(dir, 'big.json'), ' '.repeat(GRAMMAR_FILE_MAX_BYTES + 1))
    writeFileSync(join(dir, 'broken.json'), '{')
    writeFileSync(join(dir, 'regex.json'), JSON.stringify({ tokenizer: { root: [['(', 'x']] } }))
    expect(readGrammar(dir, 'link.json')).toEqual({ ok: false, error: 'symlink refused' })
    expect(readGrammar(dir, '../outside.json')).toEqual({
      ok: false,
      error: 'outside the extension',
    })
    expect(readGrammar(dir, 'missing.json')).toEqual({ ok: false, error: 'missing' })
    expect(readGrammar(dir, 'big.json')).toMatchObject({ ok: false })
    expect(readGrammar(dir, 'broken.json')).toEqual({ ok: false, error: 'not valid JSON' })
    expect(readGrammar(dir, 'regex.json')).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not start with a regular expression that compiles'),
    })
  })
})

describe('loadEditorLanguages', () => {
  it('loads each language with its grammar and skips one that is broken or already provided', () => {
    writeFileSync(join(dir, 'broken.json'), '{')
    const errors: string[] = []
    const sources: EditorLanguageSource[] = [
      { extId: 'a', dir, language: contribution() },
      { extId: 'b', dir, language: contribution() },
      { extId: 'c', dir, language: contribution({ id: 'other', grammar: 'broken.json' }) },
    ]
    expect(
      loadEditorLanguages({
        languages: () => sources,
        onError: (extId, error) => errors.push(`${extId}: ${error}`),
      }),
    ).toEqual([
      {
        extId: 'a',
        id: 'gleam',
        name: 'Gleam',
        extensions: ['.gleam'],
        filenames: [],
        configuration: { lineComment: '//' },
        grammar: GRAMMAR,
      },
    ])
    expect(errors).toEqual([
      "b: editor language 'gleam' is already provided",
      'c: broken.json: not valid JSON',
    ])
  })
})
