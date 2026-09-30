import { type MessageConnection, createMessageConnection } from 'vscode-jsonrpc'
import {
  CompletionRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentFormattingRequest,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
} from 'vscode-languageserver-protocol'
import type {
  CompletionItem,
  Diagnostic,
  Hover,
  Location,
  LocationLink,
  Range,
  TextEdit,
} from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'
import { usePluginsStore } from '../stores/pluginsStore'
import { IpcReader, IpcWriter } from './transport'

interface Client {
  id: string
  root: string
  conn: MessageConnection
  ready: Promise<void>
}

const clients = new Map<string, Client>()
interface OpenDocument {
  client: Client
  subscriptions: monaco.IDisposable
}

const docs = new Map<string, OpenDocument>()
const registered = new Set<string>()

const CLIENT_CAPS = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
      },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { dynamicRegistration: false },
    formatting: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: { workspaceFolders: true },
}

const toLspPos = (p: monaco.Position): { line: number; character: number } => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
})

const toRange = (r: Range): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
})

function severity(s?: number): monaco.MarkerSeverity {
  const S = monaco.MarkerSeverity
  return s === 1 ? S.Error : s === 2 ? S.Warning : s === 3 ? S.Info : S.Hint
}

function completionKind(k?: number): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  }
  return (k && map[k]) ?? K.Text
}

function hoverContents(contents: Hover['contents']): monaco.IMarkdownString[] {
  const one = (c: string | { language?: string; value: string }): string =>
    typeof c === 'string' ? c : c.language ? `\`\`\`${c.language}\n${c.value}\n\`\`\`` : c.value
  if (Array.isArray(contents)) return contents.map((c) => ({ value: one(c) }))
  if (typeof contents === 'string') return [{ value: contents }]
  if ('kind' in contents) return [{ value: contents.value }]
  return [{ value: one(contents) }]
}

function toDefinitions(
  result: Location | Location[] | LocationLink[] | null,
): monaco.languages.Definition | null {
  if (!result) return null
  const arr = Array.isArray(result) ? result : [result]
  return arr.map((loc) =>
    'targetUri' in loc
      ? { uri: monaco.Uri.parse(loc.targetUri), range: toRange(loc.targetSelectionRange) }
      : { uri: monaco.Uri.parse(loc.uri), range: toRange(loc.range) },
  )
}

function applyDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri))
  if (!model) return
  monaco.editor.setModelMarkers(
    model,
    'lsp',
    diagnostics.map((d) => ({
      severity: severity(d.severity),
      message: typeof d.message === 'string' ? d.message : d.message.value,
      source: d.source,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    })),
  )
}

async function ensureClient(languageId: string, filePath: string): Promise<Client | null> {
  const started = await window.pine.lsp.start(languageId, filePath)
  if (!started) return null
  const { id, root } = started

  const existing = clients.get(id)
  if (existing) {
    await existing.ready
    return existing
  }

  const conn = createMessageConnection(new IpcReader(id), new IpcWriter(id))
  const client: Client = { id, root, conn, ready: Promise.resolve() }
  clients.set(id, client)

  const onGone = (): void => {
    if (clients.get(id) === client) clients.delete(id)
    forgetDocuments(client)
    const stillRunning = [...clients.values()].some((c) => c.id.startsWith(`${languageId}::`))
    if (!stillRunning) usePluginsStore.getState().setLspStatus(languageId, 'installed')
  }

  conn.onNotification(
    PublishDiagnosticsNotification.method,
    (p: { uri: string; diagnostics: Diagnostic[] }) => applyDiagnostics(p.uri, p.diagnostics),
  )
  conn.onClose(onGone)
  window.pine.lsp.onExit(id, onGone)
  conn.listen()

  const rootUri = monaco.Uri.file(root).toString()
  client.ready = (async () => {
    await conn.sendRequest(InitializeRequest.method, {
      processId: null,
      rootUri,
      capabilities: CLIENT_CAPS,
      workspaceFolders: [{ uri: rootUri, name: root }],
    })
    conn.sendNotification(InitializedNotification.method, {})
  })()
  try {
    await client.ready
  } catch (err) {
    if (clients.get(id) === client) clients.delete(id)
    conn.dispose()
    throw err
  }
  usePluginsStore.getState().setLspStatus(languageId, 'running')
  return client
}

function forgetDocument(uri: string): void {
  docs.get(uri)?.subscriptions.dispose()
  docs.delete(uri)
}

function forgetDocuments(client: Client): void {
  for (const [uri, doc] of docs) if (doc.client === client) forgetDocument(uri)
}

function registerProviders(languageId: string): void {
  if (registered.has(languageId)) return
  registered.add(languageId)
  const clientOf = (model: monaco.editor.ITextModel): Client | undefined =>
    docs.get(model.uri.toString())?.client

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', ':', '/', '@', '<', '"', "'"],
    async provideCompletionItems(model, position) {
      const client = clientOf(model)
      if (!client) return { suggestions: [] }
      try {
        const res = (await client.conn.sendRequest(CompletionRequest.method, {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        })) as CompletionItem[] | { items: CompletionItem[] } | null
        const items: CompletionItem[] = Array.isArray(res) ? res : (res?.items ?? [])
        const word = model.getWordUntilPosition(position)
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        }
        return {
          suggestions: items.map((it) => ({
            label: it.label,
            kind: completionKind(it.kind),
            insertText: it.insertText ?? it.label,
            insertTextRules:
              it.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            detail: it.detail,
            documentation:
              typeof it.documentation === 'string' ? it.documentation : it.documentation?.value,
            sortText: it.sortText,
            filterText: it.filterText,
            range,
          })),
        }
      } catch {
        return { suggestions: [] }
      }
    },
  })

  monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      const client = clientOf(model)
      if (!client) return null
      try {
        const res = (await client.conn.sendRequest(HoverRequest.method, {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        })) as Hover | null
        if (!res?.contents) return null
        return { contents: hoverContents(res.contents), range: res.range && toRange(res.range) }
      } catch {
        return null
      }
    },
  })

  monaco.languages.registerDocumentFormattingEditProvider(languageId, {
    async provideDocumentFormattingEdits(model, options) {
      const client = clientOf(model)
      if (!client) return null
      try {
        const res = (await client.conn.sendRequest(DocumentFormattingRequest.method, {
          textDocument: { uri: model.uri.toString() },
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        })) as TextEdit[] | null
        return (res ?? []).map((edit) => ({
          range: toRange(edit.range),
          text: edit.newText,
        }))
      } catch {
        return null
      }
    },
  })

  monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position) {
      const client = clientOf(model)
      if (!client) return null
      try {
        const res = (await client.conn.sendRequest(DefinitionRequest.method, {
          textDocument: { uri: model.uri.toString() },
          position: toLspPos(position),
        })) as Location | Location[] | LocationLink[] | null
        return toDefinitions(res)
      } catch {
        return null
      }
    },
  })
}

export async function openDocument(
  model: monaco.editor.ITextModel,
  languageId: string,
): Promise<void> {
  try {
    const client = await ensureClient(languageId, model.uri.path)
    if (!client) return
    registerProviders(languageId)
    const uri = model.uri.toString()
    if (docs.has(uri)) return

    let version = 1
    client.conn.sendNotification(DidOpenTextDocumentNotification.method, {
      textDocument: { uri, languageId, version, text: model.getValue() },
    })
    const changeSub = model.onDidChangeContent(() => {
      version += 1
      client.conn.sendNotification(DidChangeTextDocumentNotification.method, {
        textDocument: { uri, version },
        contentChanges: [{ text: model.getValue() }],
      })
    })
    const disposeSub = model.onWillDispose(() => {
      forgetDocument(uri)
      try {
        client.conn.sendNotification(DidCloseTextDocumentNotification.method, {
          textDocument: { uri },
        })
      } catch {}
    })
    docs.set(uri, {
      client,
      subscriptions: {
        dispose: () => {
          changeSub.dispose()
          disposeSub.dispose()
        },
      },
    })
  } catch {}
}
