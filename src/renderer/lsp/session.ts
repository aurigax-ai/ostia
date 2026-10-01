import type { LspSessionInfo } from '@shared/languageServers'
import { PRODUCT_NAME } from '@shared/product'
import {
  type CancellationToken,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser'
import type {
  ClientCapabilities,
  Diagnostic,
  ServerCapabilities,
  TextDocumentContentChangeEvent,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'
import { normalizeUri, toLspRange } from './converters'
import { applyWorkspaceEdit } from './workspaceEdit'

const SYNC_NONE = 0
const SYNC_INCREMENTAL = 2

export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
] as const

export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
] as const

export const CLIENT_CAPABILITIES: ClientCapabilities = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        preselectSupport: true,
        tagSupport: { valueSet: [1] },
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
      },
      completionList: { itemDefaults: ['commitCharacters', 'insertTextFormat'] },
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    references: { dynamicRegistration: false },
    rename: { prepareSupport: true },
    signatureHelp: {
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, tagSupport: { valueSet: [1] } },
    documentHighlight: { dynamicRegistration: false },
    codeAction: {
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit', 'command'] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            '',
            'quickfix',
            'refactor',
            'refactor.extract',
            'refactor.inline',
            'refactor.rewrite',
            'source',
            'source.organizeImports',
            'source.fixAll',
          ],
        },
      },
    },
    semanticTokens: {
      requests: { full: true },
      tokenTypes: [...SEMANTIC_TOKEN_TYPES],
      tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
      formats: ['relative'],
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
    },
    inlayHint: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    executeCommand: { dynamicRegistration: false },
  },
  general: { positionEncodings: ['utf-16'] },
}

export interface LspSessionHooks {
  onDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void
  onClosed: () => void
}

interface SyncedDocument {
  version: number
  subscription: monaco.IDisposable
}

function folderName(root: string): string {
  return root.slice(root.lastIndexOf('/') + 1) || root
}

function fileUri(path: string): string {
  return monaco.Uri.file(path).toString()
}

export class LspSession {
  capabilities: ServerCapabilities = {}
  private readonly conn: MessageConnection
  private readonly documents = new Map<string, SyncedDocument>()
  private readonly diagnostics = new Map<string, Diagnostic[]>()
  private closed = false

  constructor(
    readonly info: LspSessionInfo,
    reader: MessageReader,
    writer: MessageWriter,
    private readonly hooks: LspSessionHooks,
  ) {
    this.conn = createMessageConnection(reader, writer)
    this.conn.onNotification(
      'textDocument/publishDiagnostics',
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const diagnostics = params.diagnostics ?? []
        this.diagnostics.set(normalizeUri(params.uri), diagnostics)
        this.hooks.onDiagnostics(params.uri, diagnostics)
      },
    )
    this.conn.onRequest('workspace/applyEdit', async (params: { edit: WorkspaceEdit }) => ({
      applied: await applyWorkspaceEdit(params.edit),
    }))
    this.conn.onRequest('workspace/workspaceFolders', () => this.workspaceFolders())
    this.conn.onRequest('client/registerCapability', () => null)
    this.conn.onRequest('client/unregisterCapability', () => null)
    this.conn.onRequest('window/workDoneProgress/create', () => null)
    this.conn.onRequest('window/showMessageRequest', () => null)
    this.conn.onUnhandledNotification(() => {})
    this.conn.onError(() => {})
    this.conn.onClose(() => this.close())
    this.conn.listen()
  }

  private workspaceFolders(): { uri: string; name: string }[] {
    return [{ uri: fileUri(this.info.root), name: folderName(this.info.root) }]
  }

  async initialize(): Promise<void> {
    const result = (await this.conn.sendRequest('initialize', {
      processId: null,
      clientInfo: { name: PRODUCT_NAME },
      rootUri: fileUri(this.info.root),
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.info.initializationOptions,
      workspaceFolders: this.workspaceFolders(),
    })) as { capabilities?: ServerCapabilities } | null
    this.capabilities = result?.capabilities ?? {}
    await this.conn.sendNotification('initialized', {})
  }

  private syncKind(): number {
    const sync = this.capabilities.textDocumentSync
    if (sync === undefined) return SYNC_NONE
    return typeof sync === 'number' ? sync : (sync.change ?? SYNC_NONE)
  }

  private sendsSave(): boolean {
    const sync = this.capabilities.textDocumentSync
    return typeof sync === 'object' && sync !== null && Boolean(sync.save)
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return
    void this.conn.sendNotification(method, params).catch(() => {})
  }

  hasDocument(uri: string): boolean {
    return this.documents.has(uri)
  }

  diagnosticsFor(uri: string): readonly Diagnostic[] {
    return this.diagnostics.get(uri) ?? []
  }

  openDocument(model: monaco.editor.ITextModel, languageId: string): void {
    const uri = model.uri.toString()
    if (this.closed || this.documents.has(uri)) return
    const document: SyncedDocument = {
      version: 1,
      subscription: model.onDidChangeContent((event) => {
        const kind = this.syncKind()
        if (kind === SYNC_NONE) return
        document.version += 1
        const contentChanges: TextDocumentContentChangeEvent[] =
          kind === SYNC_INCREMENTAL
            ? event.changes.map((change) => ({
                range: toLspRange(change.range),
                rangeLength: change.rangeLength,
                text: change.text,
              }))
            : [{ text: model.getValue() }]
        this.notify('textDocument/didChange', {
          textDocument: { uri, version: document.version },
          contentChanges,
        })
      }),
    }
    this.documents.set(uri, document)
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: document.version, text: model.getValue() },
    })
  }

  closeDocument(uri: string): void {
    const document = this.documents.get(uri)
    if (!document) return
    document.subscription.dispose()
    this.documents.delete(uri)
    this.diagnostics.delete(uri)
    this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  documentSaved(uri: string): void {
    if (this.documents.has(uri) && this.sendsSave()) {
      this.notify('textDocument/didSave', { textDocument: { uri } })
    }
  }

  async request<R>(method: string, params: unknown, token?: CancellationToken): Promise<R | null> {
    if (this.closed) return null
    try {
      const pending = token
        ? this.conn.sendRequest(method, params, token)
        : this.conn.sendRequest(method, params)
      return (await pending) as R | null
    } catch {
      return null
    }
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    for (const document of this.documents.values()) document.subscription.dispose()
    this.documents.clear()
    this.hooks.onClosed()
  }

  dispose(): void {
    this.close()
    this.conn.dispose()
  }
}
