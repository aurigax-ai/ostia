import type { EditorLanguage } from '@shared/editorLanguages'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  kind: string
  id: string
  value: unknown
  disposed: boolean
}

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  known: ['typescript', 'plaintext'],
  failGrammarFor: '' as string,
}))

vi.mock('./setup', () => {
  const record = (kind: string) => (id: string, value: unknown) => {
    if (kind === 'grammar' && id === state.failGrammarFor) throw new Error('bad grammar')
    const call: Call = { kind, id, value, disposed: false }
    state.calls.push(call)
    return {
      dispose: () => {
        call.disposed = true
      },
    }
  }
  return {
    monaco: {
      languages: {
        getLanguages: () => state.known.map((id) => ({ id })),
        register: (language: { id: string }) => {
          state.known.push(language.id)
          state.calls.push({ kind: 'register', id: language.id, value: language, disposed: false })
        },
        setLanguageConfiguration: record('configuration'),
        setMonarchTokensProvider: record('grammar'),
      },
    },
  }
})

const { applyEditorLanguages, loadEditorLanguages } = await import('./contributedLanguages')
const { fileLanguage, langFor } = await import('./language')

function language(id: string, extra: Partial<EditorLanguage> = {}): EditorLanguage {
  return {
    extId: 'ext',
    id,
    name: id.toUpperCase(),
    extensions: [`.${id}`],
    filenames: [],
    configuration: { lineComment: '#', autoClosingPairs: [['(', ')']] },
    grammar: { tokenizer: { root: [['a', 'b']] } },
    ...extra,
  }
}

beforeEach(() => {
  state.calls.length = 0
  state.failGrammarFor = ''
  applyEditorLanguages([])
  state.calls.length = 0
})

describe('applyEditorLanguages', () => {
  it('registers a new language with its file patterns, comments, pairs and grammar', () => {
    const applied = applyEditorLanguages([language('gleam', { filenames: ['gleam.toml'] })])
    expect(applied.map((l) => l.id)).toEqual(['gleam'])
    expect(state.calls.map((c) => [c.kind, c.id])).toEqual([
      ['register', 'gleam'],
      ['configuration', 'gleam'],
      ['grammar', 'gleam'],
    ])
    expect(state.calls[0].value).toEqual({
      id: 'gleam',
      aliases: ['GLEAM'],
      extensions: ['.gleam'],
      filenames: ['gleam.toml'],
    })
    expect(state.calls[1].value).toEqual({
      comments: { lineComment: '#' },
      autoClosingPairs: [{ open: '(', close: ')' }],
    })
    expect(fileLanguage('/p/app.gleam')).toBe('gleam')
    expect(langFor('/p/gleam.toml')).toBe('ini')
  })

  it('never replaces a language the editor already has', () => {
    expect(applyEditorLanguages([language('typescript')])).toEqual([])
    expect(state.calls).toEqual([])
  })

  it('skips a language whose grammar the editor refuses and keeps the others', () => {
    state.failGrammarFor = 'broken'
    const applied = applyEditorLanguages([language('broken'), language('fine')])
    expect(applied.map((l) => l.id)).toEqual(['fine'])
    expect(fileLanguage('/p/a.broken')).toBe('plaintext')
    expect(fileLanguage('/p/a.fine')).toBe('fine')
  })

  it('drops the grammar of a language that is no longer contributed and can take it back later', () => {
    applyEditorLanguages([language('zig')])
    const first = state.calls.filter((c) => c.id === 'zig' && c.kind !== 'register')
    applyEditorLanguages([])
    expect(first.every((c) => c.disposed)).toBe(true)
    expect(fileLanguage('/p/a.zig')).toBe('plaintext')
    state.calls.length = 0
    applyEditorLanguages([language('zig')])
    expect(state.calls.map((c) => c.kind)).toEqual(['configuration', 'grammar'])
    expect(fileLanguage('/p/a.zig')).toBe('zig')
  })

  it('loads what main validated', async () => {
    vi.mocked(window.ostia.editorLanguages.load).mockResolvedValue([language('nim')])
    await loadEditorLanguages()
    expect(fileLanguage('/p/a.nim')).toBe('nim')
  })
})
