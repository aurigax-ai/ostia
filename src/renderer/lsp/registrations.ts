import picomatch from 'picomatch/posix'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'

export const EXECUTE_COMMAND_METHOD = 'workspace/executeCommand'
export const DIAGNOSTIC_METHOD = 'textDocument/diagnostic'
export const WORKSPACE_SYMBOL_METHOD = 'workspace/symbol'
const MAX_REGISTRATIONS = 256
const MAX_SELECTOR_FILTERS = 64
const PATTERN_MAX = 500

export const DYNAMIC_METHODS: Readonly<Record<string, keyof ServerCapabilities>> = {
  'textDocument/completion': 'completionProvider',
  'textDocument/hover': 'hoverProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/formatting': 'documentFormattingProvider',
  'textDocument/rangeFormatting': 'documentRangeFormattingProvider',
  'textDocument/references': 'referencesProvider',
  'textDocument/rename': 'renameProvider',
  'textDocument/signatureHelp': 'signatureHelpProvider',
  'textDocument/documentSymbol': 'documentSymbolProvider',
  'textDocument/documentHighlight': 'documentHighlightProvider',
  'textDocument/codeAction': 'codeActionProvider',
  'textDocument/inlayHint': 'inlayHintProvider',
  'textDocument/semanticTokens': 'semanticTokensProvider',
  'textDocument/foldingRange': 'foldingRangeProvider',
  'textDocument/codeLens': 'codeLensProvider',
  [DIAGNOSTIC_METHOD]: 'diagnosticProvider',
  [WORKSPACE_SYMBOL_METHOD]: 'workspaceSymbolProvider',
  [EXECUTE_COMMAND_METHOD]: 'executeCommandProvider',
}

export interface DocumentFilter {
  language?: string
  scheme?: string
  pattern?: string
}

export interface Registration {
  id: string
  method: string
  options: Record<string, unknown>
  selector: DocumentFilter[] | null
}

export interface DocumentIdentity {
  uri: string
  languageId: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSelector(raw: unknown): DocumentFilter[] | null {
  if (!Array.isArray(raw)) return null
  return raw.slice(0, MAX_SELECTOR_FILTERS).map((item): DocumentFilter => {
    if (typeof item === 'string') return { language: item }
    if (!isRecord(item)) return {}
    return {
      ...(typeof item.language === 'string' ? { language: item.language } : {}),
      ...(typeof item.scheme === 'string' ? { scheme: item.scheme } : {}),
      ...(typeof item.pattern === 'string' && item.pattern.length <= PATTERN_MAX
        ? { pattern: item.pattern }
        : {}),
    }
  })
}

export function parseRegistrations(params: unknown): Registration[] {
  const list = isRecord(params) && Array.isArray(params.registrations) ? params.registrations : []
  const out: Registration[] = []
  for (const item of list.slice(0, MAX_REGISTRATIONS)) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.method !== 'string') continue
    if (!Object.hasOwn(DYNAMIC_METHODS, item.method)) continue
    const { documentSelector, ...options } = isRecord(item.registerOptions)
      ? item.registerOptions
      : {}
    out.push({
      id: item.id,
      method: item.method,
      options,
      selector: parseSelector(documentSelector),
    })
  }
  return out
}

export function parseUnregistrations(params: unknown): string[] {
  const record = isRecord(params) ? params : {}
  const list = Array.isArray(record.unregisterations)
    ? record.unregisterations
    : Array.isArray(record.unregistrations)
      ? record.unregistrations
      : []
  return list
    .filter((item): item is { id: string } => isRecord(item) && typeof item.id === 'string')
    .map((item) => item.id)
}

function commandsOf(value: unknown): string[] {
  const commands = isRecord(value) ? value.commands : undefined
  return Array.isArray(commands) ? commands.filter((c): c is string => typeof c === 'string') : []
}

export function overlayCapabilities(
  base: ServerCapabilities,
  registrations: Iterable<Registration>,
): ServerCapabilities {
  const out: Record<string, unknown> = { ...base }
  for (const registration of registrations) {
    const key = DYNAMIC_METHODS[registration.method]
    if (registration.method === EXECUTE_COMMAND_METHOD) {
      out[key] = {
        ...registration.options,
        commands: [...new Set([...commandsOf(out[key]), ...commandsOf(registration.options)])],
      }
    } else {
      out[key] = registration.options
    }
  }
  return out as ServerCapabilities
}

function filterMatches(filter: DocumentFilter, document: DocumentIdentity): boolean {
  if (filter.language !== undefined && filter.language !== document.languageId) return false
  let scheme = ''
  let path = document.uri
  try {
    const url = new URL(document.uri)
    scheme = url.protocol.slice(0, -1)
    path = decodeURIComponent(url.pathname)
  } catch {}
  if (filter.scheme !== undefined && filter.scheme !== scheme) return false
  if (filter.pattern === undefined) return true
  try {
    return picomatch(filter.pattern, { dot: true })(path)
  } catch {
    return false
  }
}

export function selectorMatches(
  selector: readonly DocumentFilter[] | null,
  document: DocumentIdentity,
): boolean {
  return selector === null || selector.some((filter) => filterMatches(filter, document))
}
