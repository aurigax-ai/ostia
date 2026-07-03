import { type MessageConnection, createMessageConnection } from 'vscode-jsonrpc'
import {
  CompletionRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
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
} from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'
import { usePluginsStore } from '../stores/pluginsStore'
import { IpcReader, IpcWriter } from './transport'

interface Client {
  id: string
  root: string
  conn: MessageConnection
  /** Resolves once `initialize`/`initialized` completed — requests must wait for it. */
  ready: Promise<void>
}

const clients = new Map<string, Client>() // key = `${languageId}::${root}`
const docToClient = new Map<string, Client>() // model uri string → its client
const registered = new Set<string>() // languageIds whose Monaco providers are installed

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
    publishDiagnostics: { relatedInformation: false },
  },
  workspace: { workspaceFolders: true },
}

// ── LSP ↔ Monaco mapping ──────────────────────────────────────────────────
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
  if ('kind' in contents) return [{ value: contents.value }] // MarkupContent
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

// ── client lifecycle ──────────────────────────────────────────────────────
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
  clients.set(id, client) // synchronous — concurrent callers find it before init completes

  const onGone = (): void => {
    clients.delete(id)
    // If no other instance of this language is running, mark the plugin idle.
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

  client.ready = (async () => {
    await conn.sendRequest(InitializeRequest.method, {
      processId: null,
      rootUri: `file://${root}`,
      capabilities: CLIENT_CAPS,
      workspaceFolders: [{ uri: `file://${root}`, name: root }],
    })
    conn.sendNotification(InitializedNotification.method, {})
  })()
  await client.ready
  usePluginsStore.getState().setLspStatus(languageId, 'running')
  return client
}

function registerProviders(languageId: string): void {
  if (registered.has(languageId)) return
  registered.add(languageId)
  const clientOf = (model: monaco.editor.ITextModel): Client | undefined =>
    docToClient.get(model.uri.toString())

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

/**
 * Attach a model to its language server (if one is installed): register providers,
 * `didOpen`, and wire `didChange`/`didClose`. Best-effort — never throws to the editor.
 */
export async function openDocument(
  model: monaco.editor.ITextModel,
  languageId: string,
): Promise<void> {
  try {
    // Only stand up a client + providers when a server is actually installed for this
    // language (else Monaco's built-in — e.g. TS/JS — is left untouched).
    const client = await ensureClient(languageId, model.uri.path)
    if (!client) return
    registerProviders(languageId)
    const uri = model.uri.toString()
    if (docToClient.has(uri)) return
    docToClient.set(uri, client)

    let version = 1
    client.conn.sendNotification(DidOpenTextDocumentNotification.method, {
      textDocument: { uri, languageId, version, text: model.getValue() },
    })
    const changeSub = model.onDidChangeContent(() => {
      version += 1
      client.conn.sendNotification(DidChangeTextDocumentNotification.method, {
        textDocument: { uri, version },
        contentChanges: [{ text: model.getValue() }], // full document sync
      })
    })
    model.onWillDispose(() => {
      changeSub.dispose()
      docToClient.delete(uri)
      try {
        client.conn.sendNotification(DidCloseTextDocumentNotification.method, {
          textDocument: { uri },
        })
      } catch {
        // connection already gone
      }
    })
  } catch {
    // LSP is best-effort; a broken server must never break the editor
  }
}
