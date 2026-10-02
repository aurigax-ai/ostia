import type { LspSessionInfo } from '@shared/languageServers'
import { PRODUCT_NAME } from '@shared/product'
import {
  type CancellationToken,
  CancellationTokenSource,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser'
import type {
  ClientCapabilities,
  Diagnostic,
  DiagnosticOptions,
  ServerCapabilities,
  TextDocumentContentChangeEvent,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'
import { normalizeUri, toLspRange } from './converters'
import {
  DIAGNOSTIC_METHOD,
  DYNAMIC_METHODS,
  type Registration,
  overlayCapabilities,
  parseRegistrations,
  parseUnregistrations,
  selectorMatches,
} from './registrations'
import { applyWorkspaceEdit } from './workspaceEdit'

const SYNC_NONE = 0
export const INITIALIZE_TIMEOUT_MS = 60_000
export const PULL_DEBOUNCE_MS = 200
export const PULL_MAX_RETRIES = 3
const SYNC_INCREMENTAL = 2
const SERVER_CANCELLED = -32802

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
      dynamicRegistration: true,
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
    hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
    definition: { dynamicRegistration: true, linkSupport: true },
    formatting: { dynamicRegistration: true },
    rangeFormatting: { dynamicRegistration: true },
    references: { dynamicRegistration: true },
    rename: { dynamicRegistration: true, prepareSupport: true },
    signatureHelp: {
      dynamicRegistration: true,
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
      tagSupport: { valueSet: [1] },
    },
    documentHighlight: { dynamicRegistration: true },
    codeAction: {
      dynamicRegistration: true,
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
      dynamicRegistration: true,
      requests: { full: true },
      tokenTypes: [...SEMANTIC_TOKEN_TYPES],
      tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
      formats: ['relative'],
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
    },
    inlayHint: { dynamicRegistration: true },
    foldingRange: { dynamicRegistration: true, lineFoldingOnly: true },
    codeLens: { dynamicRegistration: true },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    executeCommand: { dynamicRegistration: true },
    symbol: { dynamicRegistration: true },
    codeLens: { refreshSupport: true },
    diagnostics: { refreshSupport: true },
  },
  general: { positionEncodings: ['utf-16'] },
}

export interface LspSessionHooks {
  onDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void
  onClosed: () => void
  onCapabilitiesChanged?: () => void
  onCodeLensRefresh?: () => void
}

interface SyncedDocument {
  version: number
  languageId: string
  subscription: monaco.IDisposable
}

interface PulledDiagnostics {
  resultId?: string
  items: Diagnostic[]
}

interface PullState {
  timer: ReturnType<typeof setTimeout> | null
  running: CancellationTokenSource | null
  retries: number
}

interface DiagnosticReport {
  kind?: string
  resultId?: string
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DiagnosticReport>
}

function diagnosticIdentity(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.range,
    diagnostic.severity ?? null,
    diagnostic.code ?? null,
    diagnostic.source ?? null,
    diagnostic.message,
  ])
}

export function mergeDiagnostics(
  pushed: readonly Diagnostic[],
  pulled: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  for (const diagnostic of [...pushed, ...pulled]) {
    const identity = diagnosticIdentity(diagnostic)
    if (seen.has(identity)) continue
    seen.add(identity)
    out.push(diagnostic)
  }
  return out
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
  private readonly pushed = new Map<string, Diagnostic[]>()
  private readonly pulled = new Map<string, PulledDiagnostics>()
  private readonly pulls = new Map<string, PullState>()
  private readonly registrations = new Map<string, Registration>()
  private effective: ServerCapabilities | null = null
  private closed = false

  constructor(
    readonly info: LspSessionInfo,
    reader: MessageReader,
    writer: MessageWriter,
    private readonly hooks: LspSessionHooks,
    private readonly initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
  ) {
    this.conn = createMessageConnection(reader, writer)
    this.conn.onNotification(
      'textDocument/publishDiagnostics',
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const uri = normalizeUri(params.uri)
        this.pushed.set(uri, params.diagnostics ?? [])
        this.publish(uri)
      },
    )
    this.conn.onRequest('workspace/applyEdit', async (params: { edit: WorkspaceEdit }) => ({
      applied: await applyWorkspaceEdit(params.edit, this.info.editRoot),
    }))
    this.conn.onRequest('workspace/workspaceFolders', () => this.workspaceFolders())
    this.conn.onRequest('client/registerCapability', (params: unknown) => {
      this.register(parseRegistrations(params))
      return null
    })
    this.conn.onRequest('client/unregisterCapability', (params: unknown) => {
      this.unregister(parseUnregistrations(params))
      return null
    })
    this.conn.onRequest('workspace/diagnostic/refresh', () => {
      this.pullAll()
      return null
    })
    this.conn.onRequest('workspace/codeLens/refresh', () => {
      this.hooks.onCodeLensRefresh?.()
      return null
    })
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('initialize timed out')), this.initializeTimeoutMs)
    })
    const result = (await Promise.race([
      this.conn.sendRequest('initialize', {
        processId: null,
        clientInfo: { name: PRODUCT_NAME },
        rootUri: fileUri(this.info.root),
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.info.initializationOptions,
        workspaceFolders: this.workspaceFolders(),
      }),
      timedOut,
    ]).finally(() => clearTimeout(timer))) as { capabilities?: ServerCapabilities } | null
    this.capabilities = result?.capabilities ?? {}
    this.effective = null
    await this.conn.sendNotification('initialized', {})
  }

  private register(registrations: Registration[]): void {
    if (this.closed || registrations.length === 0) return
    for (const registration of registrations) {
      this.registrations.delete(registration.id)
      this.registrations.set(registration.id, registration)
    }
    this.capabilitiesChanged()
    if (registrations.some((registration) => registration.method === DIAGNOSTIC_METHOD)) {
      this.pullAll()
    }
  }

  private unregister(ids: string[]): void {
    let removed = false
    let diagnostics = false
    for (const id of ids) {
      const registration = this.registrations.get(id)
      if (!registration) continue
      this.registrations.delete(id)
      removed = true
      diagnostics ||= registration.method === DIAGNOSTIC_METHOD
    }
    if (!removed || this.closed) return
    this.capabilitiesChanged()
    if (!diagnostics) return
    for (const uri of [...this.pulled.keys()]) {
      if (this.supports(DIAGNOSTIC_METHOD, uri)) continue
      this.forgetPull(uri)
      this.pulled.delete(uri)
      this.publish(uri)
    }
  }

  private capabilitiesChanged(): void {
    this.effective = null
    this.hooks.onCapabilitiesChanged?.()
  }

  effectiveCapabilities(): ServerCapabilities {
    this.effective ??= overlayCapabilities(this.capabilities, this.registrations.values())
    return this.effective
  }

  supports(method: string, uri: string): boolean {
    const key = DYNAMIC_METHODS[method]
    if (key === undefined) return false
    if (this.capabilities[key]) return true
    const document = { uri, languageId: this.documents.get(uri)?.languageId }
    for (const registration of this.registrations.values()) {
      if (registration.method === method && selectorMatches(registration.selector, document)) {
        return true
      }
    }
    return false
  }

  runsCommand(command: string): boolean {
    return this.effectiveCapabilities().executeCommandProvider?.commands?.includes(command) === true
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

  diagnosticsFor(uri: string): Diagnostic[] {
    return mergeDiagnostics(this.pushed.get(uri) ?? [], this.pulled.get(uri)?.items ?? [])
  }

  private publish(uri: string): void {
    this.hooks.onDiagnostics(uri, this.diagnosticsFor(uri))
  }

  private diagnosticOptions(): DiagnosticOptions | undefined {
    const provider = this.effectiveCapabilities().diagnosticProvider
    return typeof provider === 'object' && provider !== null ? provider : undefined
  }

  private pullState(uri: string): PullState {
    let state = this.pulls.get(uri)
    if (!state) {
      state = { timer: null, running: null, retries: 0 }
      this.pulls.set(uri, state)
    }
    return state
  }

  private forgetPull(uri: string): void {
    const state = this.pulls.get(uri)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.running?.cancel()
    this.pulls.delete(uri)
  }

  private schedulePull(uri: string, delayMs: number): void {
    if (this.closed || !this.documents.has(uri) || !this.supports(DIAGNOSTIC_METHOD, uri)) return
    const state = this.pullState(uri)
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.pull(uri, state)
    }, delayMs)
  }

  private pullAll(): void {
    for (const uri of this.documents.keys()) this.schedulePull(uri, 0)
  }

  private pullAfterChange(uri: string): void {
    if (this.diagnosticOptions()?.interFileDependencies) {
      for (const open of this.documents.keys()) this.schedulePull(open, PULL_DEBOUNCE_MS)
    } else {
      this.schedulePull(uri, PULL_DEBOUNCE_MS)
    }
  }

  private storeReport(uri: string, report: DiagnosticReport | undefined): void {
    if (report?.kind !== 'full') return
    this.pulled.set(uri, {
      ...(typeof report.resultId === 'string' ? { resultId: report.resultId } : {}),
      items: Array.isArray(report.items) ? report.items : [],
    })
    this.publish(uri)
  }

  private async pull(uri: string, state: PullState): Promise<void> {
    if (this.closed || this.pulls.get(uri) !== state || !this.documents.has(uri)) return
    state.running?.cancel()
    const running = new CancellationTokenSource()
    state.running = running
    const identifier = this.diagnosticOptions()?.identifier
    const previousResultId = this.pulled.get(uri)?.resultId
    let report: DiagnosticReport | null
    try {
      report = (await this.conn.sendRequest(
        DIAGNOSTIC_METHOD,
        {
          textDocument: { uri },
          ...(identifier !== undefined ? { identifier } : {}),
          ...(previousResultId !== undefined ? { previousResultId } : {}),
        },
        running.token,
      )) as DiagnosticReport | null
    } catch (err) {
      if (this.pulls.get(uri) !== state || state.running !== running) return
      state.running = null
      const { code, data } = err as { code?: number; data?: { retriggerRequest?: boolean } }
      const retry = code === SERVER_CANCELLED && data?.retriggerRequest !== false
      if (retry && state.retries < PULL_MAX_RETRIES) {
        state.retries += 1
        this.schedulePull(uri, PULL_DEBOUNCE_MS)
      }
      return
    }
    if (this.pulls.get(uri) !== state || state.running !== running) return
    state.running = null
    state.retries = 0
    if (!this.documents.has(uri) || !report) return
    this.storeReport(uri, report)
    for (const [related, relatedReport] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedUri = normalizeUri(related)
      if (this.documents.has(relatedUri)) this.storeReport(relatedUri, relatedReport)
    }
  }

  openDocument(model: monaco.editor.ITextModel, languageId: string): void {
    const uri = model.uri.toString()
    if (this.closed || this.documents.has(uri)) return
    const document: SyncedDocument = {
      version: 1,
      languageId,
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
        this.pullAfterChange(uri)
      }),
    }
    this.documents.set(uri, document)
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: document.version, text: model.getValue() },
    })
    this.schedulePull(uri, 0)
  }

  closeDocument(uri: string): void {
    const document = this.documents.get(uri)
    if (!document) return
    document.subscription.dispose()
    this.documents.delete(uri)
    this.pushed.delete(uri)
    this.pulled.delete(uri)
    this.forgetPull(uri)
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
    for (const uri of [...this.pulls.keys()]) this.forgetPull(uri)
    this.documents.clear()
    this.hooks.onClosed()
  }

  dispose(): void {
    this.close()
    this.conn.dispose()
  }
}
