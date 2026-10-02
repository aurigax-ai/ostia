import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeModel, createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))

const { registerProviders } = await import('./providers')

type Request = (method: string, params: unknown, token?: unknown) => Promise<unknown>

const model = new FakeModel('/work/a.txt', 'call fak\nsecond line')
const range = { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } }
let request: ReturnType<typeof vi.fn<Request>>

function register(capabilities: Record<string, unknown>): { dispose: () => void } {
  return registerProviders('plaintext', capabilities, (candidate) =>
    candidate === (model as never) ? ({ request } as never) : undefined,
  )
}

function provider<T>(kind: string, method: string): T {
  return fake.active(kind)[0].provider[method] as T
}

beforeEach(() => {
  fake.registrations.length = 0
  request = vi.fn<Request>()
})

describe('registerProviders', () => {
  it('registers nothing for a server without features and disposes what it registered', () => {
    register({ textDocumentSync: 1 })
    expect(fake.registrations).toHaveLength(0)
    const registration = register({
      hoverProvider: true,
      definitionProvider: true,
      documentFormattingProvider: true,
      completionProvider: {},
    })
    expect(fake.active('HoverProvider')).toHaveLength(1)
    expect(fake.registrations).toHaveLength(4)
    registration.dispose()
    expect(fake.registrations.every((r) => r.disposed)).toBe(true)
  })

  it('asks for completions at the cursor with the trigger character and maps the list', async () => {
    register({ completionProvider: { triggerCharacters: ['.'] } })
    request.mockResolvedValue({
      isIncomplete: true,
      itemDefaults: { insertTextFormat: 2 },
      items: [
        { label: 'fakeAlpha' },
        { label: 'fakeEdit', textEdit: { range, newText: 'edited' } },
      ],
    })
    const provide = provider<
      (m: unknown, p: unknown, c: unknown, t: unknown) => Promise<Record<string, unknown>>
    >('CompletionItemProvider', 'provideCompletionItems')
    const result = await provide(
      model,
      { lineNumber: 1, column: 9 },
      { triggerKind: 1, triggerCharacter: '.' },
      'token',
    )
    expect(request).toHaveBeenCalledWith(
      'textDocument/completion',
      {
        textDocument: { uri: 'file:///work/a.txt' },
        position: { line: 0, character: 8 },
        context: { triggerKind: 2, triggerCharacter: '.' },
      },
      'token',
    )
    expect(result.incomplete).toBe(true)
    expect(result.suggestions).toMatchObject([
      {
        label: 'fakeAlpha',
        insertText: 'fakeAlpha',
        insertTextRules: 4,
        range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 },
      },
      {
        label: 'fakeEdit',
        insertText: 'edited',
        range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 },
      },
    ])
  })

  it('accepts a bare array of completions and offers nothing when the request fails or the document is not attached', async () => {
    register({ completionProvider: {} })
    const provide = provider<
      (m: unknown, p: unknown, c: unknown) => Promise<{ suggestions: unknown[] }>
    >('CompletionItemProvider', 'provideCompletionItems')
    request.mockResolvedValueOnce([{ label: 'one' }])
    expect((await provide(model, { lineNumber: 1, column: 1 }, {})).suggestions).toHaveLength(1)
    expect(request.mock.calls[0][1]).toMatchObject({ context: { triggerKind: 1 } })
    request.mockResolvedValueOnce(null)
    expect(await provide(model, { lineNumber: 1, column: 1 }, {})).toEqual({ suggestions: [] })
    const other = new FakeModel('/work/other.txt', '')
    expect(await provide(other, { lineNumber: 1, column: 1 }, {})).toEqual({ suggestions: [] })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('resolves a completion only when the server supports it, through the session that offered it', async () => {
    register({ completionProvider: {} })
    expect(fake.active('CompletionItemProvider')[0].provider.resolveCompletionItem).toBeUndefined()
    fake.registrations.length = 0
    register({ completionProvider: { resolveProvider: true } })
    const provide = provider<
      (m: unknown, p: unknown, c: unknown) => Promise<{ suggestions: unknown[] }>
    >('CompletionItemProvider', 'provideCompletionItems')
    const resolve = provider<(item: unknown) => Promise<Record<string, unknown>>>(
      'CompletionItemProvider',
      'resolveCompletionItem',
    )
    request.mockResolvedValueOnce([{ label: 'one', data: 7 }])
    const [item] = (await provide(model, { lineNumber: 1, column: 1 }, {})).suggestions
    request.mockResolvedValueOnce({
      label: 'one',
      detail: 'resolved detail',
      documentation: { kind: 'markdown', value: '**doc**' },
      additionalTextEdits: [{ range, newText: 'import' }],
    })
    const resolved = await resolve(item)
    expect(request).toHaveBeenLastCalledWith(
      'completionItem/resolve',
      { label: 'one', data: 7 },
      undefined,
    )
    expect(resolved).toMatchObject({
      label: 'one',
      detail: 'resolved detail',
      documentation: { value: '**doc**' },
      additionalTextEdits: [
        {
          range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 },
          text: 'import',
        },
      ],
    })
    request.mockResolvedValueOnce(null)
    expect(await resolve(item)).toBe(item)
  })

  it('maps hover, definition and formatting answers', async () => {
    register({ hoverProvider: true, definitionProvider: true, documentFormattingProvider: true })
    request.mockResolvedValueOnce({ contents: { kind: 'markdown', value: 'hi' }, range })
    const hover = provider<(m: unknown, p: unknown) => Promise<unknown>>(
      'HoverProvider',
      'provideHover',
    )
    expect(await hover(model, { lineNumber: 1, column: 6 })).toEqual({
      contents: [{ value: 'hi' }],
      range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 },
    })

    request.mockResolvedValueOnce([{ uri: 'file:///work/b.txt', range }])
    const definition = provider<(m: unknown, p: unknown) => Promise<{ uri: { path: string } }[]>>(
      'DefinitionProvider',
      'provideDefinition',
    )
    const locations = await definition(model, { lineNumber: 1, column: 6 })
    expect(locations.map((l) => l.uri.path)).toEqual(['/work/b.txt'])

    request.mockResolvedValueOnce([{ range, newText: 'FAK' }])
    const format = provider<(m: unknown, o: unknown) => Promise<unknown>>(
      'DocumentFormattingEditProvider',
      'provideDocumentFormattingEdits',
    )
    expect(await format(model, { tabSize: 4, insertSpaces: false })).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 },
        text: 'FAK',
      },
    ])
    expect(request).toHaveBeenLastCalledWith(
      'textDocument/formatting',
      { textDocument: { uri: 'file:///work/a.txt' }, options: { tabSize: 4, insertSpaces: false } },
      undefined,
    )
  })
})
