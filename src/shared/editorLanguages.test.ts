import { describe, expect, it } from 'vitest'
import {
  GRAMMAR_MAX_RULES,
  languageForPath,
  parseEditorLanguages,
  validateMonarchGrammar,
} from './editorLanguages'

const inside = (path: string): boolean => !path.startsWith('..') && !path.startsWith('/')

function language(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gleam',
    name: 'Gleam',
    extensions: ['.gleam'],
    grammar: 'gleam.monarch.json',
    ...extra,
  }
}

function problem(extra: Record<string, unknown>): string {
  const parsed = parseEditorLanguages([language(extra)], inside)
  return typeof parsed === 'string' ? parsed : ''
}

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

  it('knows a contributed language by file name, then by its longest suffix', () => {
    const contributed = [
      { id: 'gleam', extensions: ['.gleam'], filenames: ['gleam.toml'] },
      { id: 'gleam-test', extensions: ['.test.gleam'], filenames: [] },
      { id: 'make', extensions: [], filenames: ['Makefile'] },
    ]
    expect(languageForPath('/p/app.gleam', contributed)).toBe('gleam')
    expect(languageForPath('/p/APP.GLEAM', contributed)).toBe('gleam')
    expect(languageForPath('/p/app.test.gleam', contributed)).toBe('gleam-test')
    expect(languageForPath('/p/Makefile', contributed)).toBe('make')
    expect(languageForPath('/p/.gleam', contributed)).toBe('plaintext')
    expect(languageForPath('/p/notes.txt', contributed)).toBe('plaintext')
  })

  it('never lets a contribution take a file the editor already has a language for', () => {
    const contributed = [{ id: 'mine', extensions: ['.ts', '.toml'], filenames: ['a.rs'] }]
    expect(languageForPath('/p/a.ts', contributed)).toBe('typescript')
    expect(languageForPath('/p/a.rs', contributed)).toBe('rust')
    expect(languageForPath('/p/Cargo.toml', contributed)).toBe('ini')
  })
})

describe('parseEditorLanguages', () => {
  it('fills defaults and keeps the comment and bracket configuration', () => {
    expect(
      parseEditorLanguages(
        [
          language({
            filenames: ['gleam.toml'],
            configuration: {
              lineComment: '//',
              blockComment: ['/*', '*/'],
              brackets: [['{', '}']],
              autoClosingPairs: [['"', '"']],
              ignored: true,
            },
          }),
          language({ id: 'other', extensions: undefined, filenames: ['Otherfile'] }),
        ],
        inside,
      ),
    ).toEqual([
      {
        id: 'gleam',
        name: 'Gleam',
        extensions: ['.gleam'],
        filenames: ['gleam.toml'],
        configuration: {
          lineComment: '//',
          blockComment: ['/*', '*/'],
          brackets: [['{', '}']],
          autoClosingPairs: [['"', '"']],
        },
        grammar: 'gleam.monarch.json',
      },
      {
        id: 'other',
        name: 'Gleam',
        extensions: [],
        filenames: ['Otherfile'],
        configuration: {},
        grammar: 'gleam.monarch.json',
      },
    ])
    expect(parseEditorLanguages(undefined, inside)).toEqual([])
  })

  it('refuses an id the editor already has, a duplicate and a bad one', () => {
    expect(problem({ id: 'typescript' })).toMatch(/already has/)
    expect(problem({ id: 'plaintext' })).toMatch(/already has/)
    expect(problem({ id: 'ostia-settings' })).toMatch(/already has/)
    expect(problem({ id: 'Bad Id' })).toMatch(/invalid id/)
    expect(parseEditorLanguages([language(), language()], inside)).toMatch(/duplicate id 'gleam'/)
    expect(parseEditorLanguages(Array(17).fill(language()), inside)).toMatch(/at most 16/)
  })

  it('needs a name, a file pattern and a grammar file inside the extension', () => {
    expect(problem({ name: '' })).toMatch(/name must be/)
    expect(problem({ extensions: [] })).toMatch(/at least one extension or file name/)
    expect(problem({ extensions: ['gleam'] })).toMatch(/extensions must be/)
    expect(problem({ extensions: ['.a/b'] })).toMatch(/extensions must be/)
    expect(problem({ filenames: ['../x'] })).toMatch(/filenames must be/)
    expect(problem({ grammar: '../outside.json' })).toMatch(/inside the extension/)
    expect(problem({ grammar: 'grammar.js' })).toMatch(/\.json file/)
  })

  it('takes comments and brackets only as short strings', () => {
    expect(problem({ configuration: { lineComment: 'x'.repeat(11) } })).toMatch(/lineComment/)
    expect(problem({ configuration: { blockComment: ['/*'] } })).toMatch(/blockComment/)
    expect(problem({ configuration: { brackets: [['{', 1]] } })).toMatch(/brackets/)
    expect(problem({ configuration: { autoClosingPairs: 'no' } })).toMatch(/autoClosingPairs/)
    expect(problem({ configuration: [] })).toMatch(/configuration must be an object/)
  })
})

describe('validateMonarchGrammar', () => {
  const grammar = {
    defaultToken: 'invalid',
    keywords: ['fn', 'let'],
    symbols: '[=><!~?:&|+\\-*/^%]+',
    tokenizer: {
      root: [
        ['[a-z_]\\w*', { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        ['@symbols', 'operator'],
        { include: '@whitespace' },
        { regex: '\\d+', action: 'number' },
      ],
      whitespace: [['[ \\t\\r\\n]+', '']],
    },
  }

  it('accepts a grammar whose rules all start with a regular expression that compiles', () => {
    expect(validateMonarchGrammar(grammar)).toEqual(grammar)
  })

  it('drops prototype keys and anything that is not plain data', () => {
    const dirty = JSON.parse(
      '{"__proto__":{"x":1},"constructor":"x","tokenizer":{"root":[["a","b"]],"prototype":[]}}',
    )
    expect(validateMonarchGrammar(dirty)).toEqual({ tokenizer: { root: [['a', 'b']] } })
  })

  it('refuses a grammar without states, with a rule that does not compile, or too many rules', () => {
    expect(validateMonarchGrammar([])).toMatch(/JSON object/)
    expect(validateMonarchGrammar({})).toMatch(/tokenizer must be an object/)
    expect(validateMonarchGrammar({ tokenizer: {} })).toMatch(/1-200 states/)
    expect(validateMonarchGrammar({ tokenizer: { root: 'x' } })).toMatch(/must be an array/)
    expect(validateMonarchGrammar({ tokenizer: { root: [['(unclosed', 'x']] } })).toMatch(
      /tokenizer\.root\[0\] does not start with a regular expression that compiles/,
    )
    expect(validateMonarchGrammar({ tokenizer: { root: [[42, 'x']] } })).toMatch(/root\[0\]/)
    expect(validateMonarchGrammar({ tokenizer: { root: [{ action: 'x' }] } })).toMatch(/root\[0\]/)
    expect(validateMonarchGrammar({ symbols: '[', tokenizer: { root: [['a', 'b']] } })).toMatch(
      /symbols is not a regular expression/,
    )
    expect(
      validateMonarchGrammar({
        tokenizer: { root: Array.from({ length: GRAMMAR_MAX_RULES + 1 }, () => ['a', 'b']) },
      }),
    ).toMatch(/at most 500 rules/)
    expect(validateMonarchGrammar({ tokenizer: { root: [['a'.repeat(2001), 'x']] } })).toMatch(
      /root\[0\]/,
    )
  })
})
