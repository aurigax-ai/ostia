import type { LspSessionInfo } from '@shared/languageServers'
import type { Diagnostic } from 'vscode-languageserver-protocol'
import { claimedLanguages } from '../monaco/builtinFeatures'
import { fileLanguage } from '../monaco/language'
import { builtinFeatures, monaco } from '../monaco/setup'
import { normalizeUri, toMarkers } from './converters'
import { registerProviders } from './providers'
import { LspSession } from './session'
import { IpcReader, IpcWriter } from './transport'

interface ClientSession {
  info: LspSessionInfo
  session: LspSession
  ready: Promise<boolean>
  documents: Set<string>
  offExit: () => void
}

interface OpenDocument {
  model: monaco.editor.ITextModel
  paneId: string
  holders: number
  attached: Map<string, string>
  queue: Promise<void>
  disposal: monaco.IDisposable | null
}

const sessions = new Map<string, ClientSession>()
const documents = new Map<string, OpenDocument>()
const providers = new Map<string, monaco.IDisposable>()
let stopWatching: (() => void) | null = null

function markerOwner(serverKey: string): string {
  return `lsp:${serverKey}`
}

function providerKey(serverKey: string, language: string): string {
  return `${serverKey}\n${language}`
}

function sessionFor(serverKey: string, model: monaco.editor.ITextModel): LspSession | undefined {
  const sessionId = documents.get(model.uri.toString())?.attached.get(serverKey)
  return sessionId ? sessions.get(sessionId)?.session : undefined
}

function applyDiagnostics(entry: ClientSession, uri: string, diagnostics: Diagnostic[]): void {
  const key = normalizeUri(uri)
  if (!entry.documents.has(key)) return
  const model = documents.get(key)?.model
  if (!model || model.isDisposed()) return
  monaco.editor.setModelMarkers(model, markerOwner(entry.info.serverKey), toMarkers(diagnostics))
}

function clearMarkers(model: monaco.editor.ITextModel, serverKey: string): void {
  if (!model.isDisposed()) monaco.editor.setModelMarkers(model, markerOwner(serverKey), [])
}

function disposeProvidersOf(serverKey: string): void {
  const stillServed = [...sessions.values()].some((entry) => entry.info.serverKey === serverKey)
  if (stillServed) return
  const prefix = `${serverKey}\n`
  for (const [key, registration] of [...providers]) {
    if (!key.startsWith(prefix)) continue
    registration.dispose()
    providers.delete(key)
  }
}

function sessionEnded(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry) return
  sessions.delete(sessionId)
  entry.offExit()
  entry.session.dispose()
  const orphaned: OpenDocument[] = []
  for (const uri of entry.documents) {
    const document = documents.get(uri)
    if (!document || document.attached.get(entry.info.serverKey) !== sessionId) continue
    document.attached.delete(entry.info.serverKey)
    clearMarkers(document.model, entry.info.serverKey)
    orphaned.push(document)
  }
  entry.documents.clear()
  disposeProvidersOf(entry.info.serverKey)
  for (const document of orphaned) schedule(document)
}

function ensureSession(info: LspSessionInfo): ClientSession {
  const existing = sessions.get(info.sessionId)
  if (existing) return existing
  const session = new LspSession(
    info,
    new IpcReader(info.sessionId),
    new IpcWriter(info.sessionId),
    {
      onDiagnostics: (uri, diagnostics) => applyDiagnostics(entry, uri, diagnostics),
      onClosed: () => sessionEnded(info.sessionId),
    },
  )
  const entry: ClientSession = {
    info,
    session,
    ready: session.initialize().then(
      () => true,
      () => false,
    ),
    documents: new Set(),
    offExit: window.pine.lsp.onExit(info.sessionId, () => sessionEnded(info.sessionId)),
  }
  sessions.set(info.sessionId, entry)
  return entry
}

function detach(document: OpenDocument, serverKey: string): void {
  const uri = document.model.uri.toString()
  const sessionId = document.attached.get(serverKey)
  if (!sessionId) return
  document.attached.delete(serverKey)
  clearMarkers(document.model, serverKey)
  const entry = sessions.get(sessionId)
  if (!entry) return
  entry.documents.delete(uri)
  entry.session.closeDocument(uri)
  window.pine.lsp.release(sessionId)
}

function isCurrent(document: OpenDocument): boolean {
  return (
    document.holders > 0 &&
    !document.model.isDisposed() &&
    documents.get(document.model.uri.toString()) === document
  )
}

async function attach(document: OpenDocument): Promise<void> {
  if (!isCurrent(document)) return
  const uri = document.model.uri.toString()
  const offered = await window.pine.lsp.open(document.paneId, document.model.uri.path)
  if (isCurrent(document)) for (const info of offered) ensureSession(info)
  for (const info of offered) {
    if (!isCurrent(document) || document.attached.get(info.serverKey) === info.sessionId) {
      window.pine.lsp.release(info.sessionId)
      continue
    }
    detach(document, info.serverKey)
    const entry = ensureSession(info)
    const ready = await entry.ready
    if (!ready || !isCurrent(document) || sessions.get(info.sessionId) !== entry) {
      window.pine.lsp.release(info.sessionId)
      continue
    }
    document.attached.set(info.serverKey, info.sessionId)
    entry.documents.add(uri)
    const language = document.model.getLanguageId()
    const key = providerKey(info.serverKey, language)
    if (!providers.has(key)) {
      providers.set(
        key,
        registerProviders(language, entry.session.capabilities, (model) =>
          sessionFor(info.serverKey, model),
        ),
      )
    }
    entry.session.openDocument(document.model, info.languageId)
  }
}

function schedule(document: OpenDocument): void {
  document.queue = document.queue.then(() => attach(document)).catch(() => {})
}

function watchServers(): void {
  if (stopWatching) return
  stopWatching = window.pine.lsp.onServersChanged((servers) => {
    builtinFeatures.apply(claimedLanguages(servers))
    for (const document of documents.values()) schedule(document)
  })
}

export async function startLanguageServices(): Promise<void> {
  watchServers()
  builtinFeatures.apply(claimedLanguages(await window.pine.lsp.servers()))
}

function close(document: OpenDocument): void {
  const uri = document.model.uri.toString()
  if (documents.get(uri) === document) documents.delete(uri)
  document.disposal?.dispose()
  document.disposal = null
  for (const serverKey of [...document.attached.keys()]) detach(document, serverKey)
}

export function openDocument(model: monaco.editor.ITextModel, paneId: string): () => void {
  if (model.getLanguageId() !== fileLanguage(model.uri.path)) return () => {}
  watchServers()
  const uri = model.uri.toString()
  let document = documents.get(uri)
  if (!document) {
    const created: OpenDocument = {
      model,
      paneId,
      holders: 0,
      attached: new Map(),
      queue: Promise.resolve(),
      disposal: null,
    }
    documents.set(uri, created)
    created.disposal = model.onWillDispose(() => {
      created.holders = 0
      close(created)
    })
    document = created
  }
  const held = document
  held.holders += 1
  held.paneId = paneId
  schedule(held)
  let released = false
  return () => {
    if (released) return
    released = true
    held.holders -= 1
    if (held.holders <= 0) close(held)
  }
}

export function documentSaved(model: monaco.editor.ITextModel): void {
  const uri = model.uri.toString()
  const document = documents.get(uri)
  if (!document) return
  for (const sessionId of document.attached.values()) {
    sessions.get(sessionId)?.session.documentSaved(uri)
  }
}

export function resetLspClient(): void {
  for (const document of [...documents.values()]) {
    document.holders = 0
    close(document)
  }
  for (const sessionId of [...sessions.keys()]) sessionEnded(sessionId)
  for (const registration of providers.values()) registration.dispose()
  providers.clear()
  documents.clear()
  stopWatching?.()
  stopWatching = null
}
