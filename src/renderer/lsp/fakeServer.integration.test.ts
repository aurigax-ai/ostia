import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import type { CodeAction, Diagnostic } from 'vscode-languageserver-protocol'
import { FakeModel, createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))
vi.mock('vscode-jsonrpc/browser', async () => await import('vscode-jsonrpc/node'))

const { APPLY_CODE_ACTION_COMMAND, registerProviders } = await import('./providers')
const { LspSession } = await import('./session')

const FAKE_SERVER = resolve(__dirname, '../../../test/fixtures/lsp/fake-server.mjs')
const TEXT = [
  'fn alpha uses ERROR and alpha',
  'let count = fakeCall(first, second)',
  'KEYWORD FORMATME here',
  'tail FORMATME',
].join('\n')

type Provide = (...args: unknown[]) => Promise<unknown>

let root: string
let proc: ChildProcessWithoutNullStreams
let session: InstanceType<typeof LspSession>
let model: FakeModel
let uri: string
let recordFile: string
const published: Diagnostic[][] = []

function provider(kind: string, method: string): Provide {
  const [registration] = fake.active(kind)
  if (!registration) throw new Error(`no ${kind} registered`)
  return registration.provider[method] as Provide
}

function at(line: number, text: string, within = 0): { lineNumber: number; column: number } {
  const column = model.getValue().split('\n')[line - 1].indexOf(text) + 1 + within
  return { lineNumber: line, column }
}

async function nextDiagnostics(after: number): Promise<string[]> {
  await vi.waitFor(() => expect(published.length).toBeGreaterThan(after), { timeout: 10_000 })
  return (published.at(-1) ?? []).map((d) => d.message as string)
}

function recorded(): string[] {
  return readFileSync(recordFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { method: string }).method)
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-lsp-dom-')))
  recordFile = join(root, 'record.jsonl')
  writeFileSync(join(root, 'other.txt'), 'alpha lives here too\nand alpha again\n')
  proc = spawn(process.execPath, [FAKE_SERVER, '--sync=incremental', `--record=${recordFile}`])
  session = new LspSession(
    {
      sessionId: 's1',
      serverKey: 'fake-lang/fake',
      root,
      editRoot: root,
      languageId: 'fake',
      initializationOptions: {},
    },
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin),
    {
      onDiagnostics: (_uri, diagnostics) => published.push(diagnostics),
      onClosed: () => {},
    },
  )
  await session.initialize()
  model = fake.addModel(new FakeModel(join(root, 'main.txt'), TEXT))
  uri = model.uri.toString()
  registerProviders('plaintext', session.capabilities, (candidate) =>
    candidate === (model as never) ? session : undefined,
  )
  session.openDocument(model as never, 'fake')
  await nextDiagnostics(0)
}, 30_000)

afterAll(() => {
  session.dispose()
  proc.kill()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  vi.mocked(window.ostia.fs.read).mockImplementation(async (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  })
  vi.mocked(window.ostia.fs.write).mockImplementation(async (path, text) => {
    writeFileSync(path, text)
    return true
  })
})

describe('the editor client against a real fake language server', () => {
  it('registers a provider for every feature the server reports', () => {
    expect(fake.registrations.map((r) => r.kind).sort()).toEqual([
      'CodeActionProvider',
      'CompletionItemProvider',
      'DefinitionProvider',
      'DocumentFormattingEditProvider',
      'DocumentHighlightProvider',
      'DocumentRangeFormattingEditProvider',
      'DocumentSemanticTokensProvider',
      'DocumentSymbolProvider',
      'HoverProvider',
      'InlayHintsProvider',
      'ReferenceProvider',
      'RenameProvider',
      'SignatureHelpProvider',
    ])
    const completion = fake.active('CompletionItemProvider')[0].provider
    expect(completion.triggerCharacters).toEqual(['.', '#'])
    const signature = fake.active('SignatureHelpProvider')[0].provider
    expect(signature.signatureHelpTriggerCharacters).toEqual(['(', ','])
  })

  it('shows the server’s diagnostics for the opened text', () => {
    expect(published.at(-1)).toMatchObject([
      {
        message: 'fake error on line 1',
        severity: 1,
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 19 } },
      },
    ])
  })

  it('completes with the server’s text edit, extra edits and snippet, and resolves documentation', async () => {
    const position = at(1, 'alpha', 3)
    const list = (await provider('CompletionItemProvider', 'provideCompletionItems')(
      model,
      position,
      {},
    )) as { suggestions: Record<string, unknown>[] }
    expect(list.suggestions.map((s) => s.label)).toEqual(['fakeAlpha', 'fakeEdit', 'fakeSnippet'])
    expect(list.suggestions[1]).toMatchObject({
      insertText: 'fakeEdited',
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 },
      additionalTextEdits: [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          text: 'imported by fake\n',
        },
      ],
    })
    expect(list.suggestions[2]).toMatchObject({
      insertText: 'fakeCall(${1:argument})',
      insertTextRules: 4,
    })
    const resolved = (await provider(
      'CompletionItemProvider',
      'resolveCompletionItem',
    )(list.suggestions[0])) as { documentation: { value: string } }
    expect(resolved.documentation).toEqual({ value: 'resolved **fakeAlpha**' })
  })

  it('answers hover and go to definition', async () => {
    expect(await provider('HoverProvider', 'provideHover')(model, at(1, 'alpha', 1))).toEqual({
      contents: [{ value: 'fake hover: **alpha**' }],
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 },
    })
    const definition = (await provider('DefinitionProvider', 'provideDefinition')(
      model,
      at(2, 'count'),
    )) as { uri: { toString(): string }; range: unknown }[]
    expect(definition.map((d) => [d.uri.toString(), d.range])).toEqual([
      [uri, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }],
    ])
  })

  it('formats the whole document or only the selected range', async () => {
    const options = { tabSize: 2, insertSpaces: true }
    const all = (await provider('DocumentFormattingEditProvider', 'provideDocumentFormattingEdits')(
      model,
      options,
    )) as { range: { startLineNumber: number }; text: string }[]
    expect(all.map((e) => [e.range.startLineNumber, e.text])).toEqual([
      [3, 'formatted'],
      [4, 'formatted'],
    ])
    const part = (await provider(
      'DocumentRangeFormattingEditProvider',
      'provideDocumentRangeFormattingEdits',
    )(model, { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 5 }, options)) as {
      range: { startLineNumber: number }
    }[]
    expect(part.map((e) => e.range.startLineNumber)).toEqual([4])
  })

  it('finds references and highlights of the word under the cursor', async () => {
    const references = (await provider('ReferenceProvider', 'provideReferences')(
      model,
      at(1, 'alpha'),
      { includeDeclaration: true },
    )) as { range: { startColumn: number } }[]
    expect(references.map((r) => r.range.startColumn)).toEqual([4, 25])
    const highlights = (await provider('DocumentHighlightProvider', 'provideDocumentHighlights')(
      model,
      at(1, 'alpha'),
    )) as { range: { startColumn: number }; kind: number }[]
    expect(highlights).toEqual([
      { range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 }, kind: 0 },
      { range: { startLineNumber: 1, startColumn: 25, endLineNumber: 1, endColumn: 30 }, kind: 0 },
    ])
  })

  it('shows signature help with the active parameter', async () => {
    const help = (await provider('SignatureHelpProvider', 'provideSignatureHelp')(
      model,
      at(2, 'second'),
      undefined,
      { triggerKind: 2, triggerCharacter: ',', isRetrigger: false },
    )) as { value: { activeParameter: number; signatures: { label: string }[] } }
    expect(help.value.activeParameter).toBe(1)
    expect(help.value.signatures[0].label).toBe('fakeCall(first: string, second: number)')
  })

  it('lists document symbols, inlay hints and semantic tokens', async () => {
    const symbols = (await provider('DocumentSymbolProvider', 'provideDocumentSymbols')(model)) as {
      name: string
      kind: number
      selectionRange: unknown
    }[]
    expect(symbols).toMatchObject([
      {
        name: 'alpha',
        kind: 11,
        selectionRange: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 },
      },
    ])
    const hints = (await provider('InlayHintsProvider', 'provideInlayHints')(model, {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    })) as { hints: unknown[] }
    expect(hints.hints).toEqual([
      { position: { lineNumber: 2, column: 10 }, label: ': fake', kind: 1 },
    ])
    const semantic = fake.active('DocumentSemanticTokensProvider')[0].provider
    expect((semantic.getLegend as () => unknown)()).toEqual({
      tokenTypes: ['keyword', 'function'],
      tokenModifiers: ['declaration'],
    })
    const tokens = (await (semantic.provideDocumentSemanticTokens as Provide)(model, null)) as {
      data: Uint32Array
    }
    expect([...tokens.data]).toEqual([0, 0, 2, 0, 0, 2, 0, 7, 0, 0])
  })

  it('renames in the open document through the editor and in a closed file on disk', async () => {
    const location = (await provider('RenameProvider', 'resolveRenameLocation')(
      model,
      at(1, 'alpha', 2),
    )) as { range: unknown; text: string }
    expect(location).toEqual({
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 },
      text: 'alpha',
    })
    const before = published.length
    model.edit(
      { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
      'RENAME_ALSO other.txt ',
    )
    await nextDiagnostics(before)
    const edit = (await provider('RenameProvider', 'provideRenameEdits')(
      model,
      at(1, 'alpha'),
      'beta',
    )) as { edits: { resource: { toString(): string }; textEdit: { text: string } }[] }
    expect(edit.edits.map((e) => [e.resource.toString(), e.textEdit.text])).toEqual([
      [uri, 'beta'],
      [uri, 'beta'],
    ])
    expect(readFileSync(join(root, 'other.txt'), 'utf8')).toBe(
      'beta lives here too\nand beta again\n',
    )
  })

  it('sends only what changed, so the server’s diagnostics follow the edit', async () => {
    const before = published.length
    model.edit({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, 'WARN')
    expect(await nextDiagnostics(before)).toEqual([
      'fake error on line 1',
      'fake warning on line 2',
    ])
    expect(model.getValue().split('\n')[1]).toBe('WARN count = fakeCall(first, second)')
  })

  it('offers the server’s quick fix and applies it to the document when chosen', async () => {
    const range = { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 20 }
    const list = (await provider('CodeActionProvider', 'provideCodeActions')(model, range, {
      markers: [],
      trigger: 1,
    })) as {
      actions: { title: string; kind: string; command: { id: string; arguments: unknown[] } }[]
    }
    expect(list.actions).toMatchObject([
      {
        title: 'Replace ERROR with FIXED',
        kind: 'quickfix',
        command: { id: APPLY_CODE_ACTION_COMMAND },
      },
    ])
    const [chosenSession, action] = list.actions[0].command.arguments as [unknown, CodeAction]
    expect(chosenSession).toBe(session)
    expect(action.diagnostics?.[0].message).toBe('fake error on line 1')
    const before = published.length
    fake.commands.get(APPLY_CODE_ACTION_COMMAND)?.(null, chosenSession, action)
    expect(await nextDiagnostics(before)).toEqual(['fake warning on line 2'])
    expect(model.getValue().split('\n')[0]).toBe('fn alpha uses FIXED and alpha')
    const none = (await provider('CodeActionProvider', 'provideCodeActions')(
      model,
      { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 },
      { markers: [], trigger: 2 },
    )) as { actions: unknown[] }
    expect(none.actions).toEqual([])
  })

  it('tells the server when the file was saved and when it closes', async () => {
    session.documentSaved(uri)
    session.closeDocument(uri)
    await vi.waitFor(() => expect(recorded().at(-1)).toBe('textDocument/didClose'), {
      timeout: 10_000,
    })
    const methods = recorded()
    expect(methods).toContain('textDocument/didSave')
    expect(methods.filter((m) => m === 'textDocument/didChange').length).toBeGreaterThanOrEqual(3)
  })
})
