import { PassThrough } from 'node:stream'
import { type BrowseProvider, listenForBrowse } from '@aurigax-ai/ostia-extension-sdk/browse'
import {
  BROWSE_CHUNK_METHOD,
  BROWSE_ENTRIES_METHOD,
  BROWSE_READ_AT_METHOD,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import type { BrowseCandidate } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../src/main/control/idRegistry'
import {
  ExtensionBrowse,
  type ExtensionBrowseHost,
  type ExtensionBrowseTiming,
} from '../src/main/extensions/extensionBrowse'

export interface BrowseHarness {
  browse: ExtensionBrowse
  hostConn: MessageConnection
  extConn: MessageConnection
  calls: { readAt: number; entries: number; chunk: number }
  recycled: string[]
  dispose: () => void
}

export interface HarnessOptions {
  providers?: Record<string, BrowseProvider>
  raw?: (extConn: MessageConnection) => void
  candidates: BrowseCandidate[]
  timing?: ExtensionBrowseTiming
  extId?: string
}

export function browseHarness(options: HarnessOptions): BrowseHarness {
  const extId = options.extId ?? 'archives'
  const toHost = new PassThrough()
  const toExt = new PassThrough()
  const hostConn = createMessageConnection(
    new StreamMessageReader(toHost),
    new StreamMessageWriter(toExt),
  )
  const extConn = createMessageConnection(
    new StreamMessageReader(toExt),
    new StreamMessageWriter(toHost),
  )
  const process = {}
  const recycled: string[] = []
  const host: ExtensionBrowseHost = {
    candidates: () => options.candidates,
    connected: async () => hostConn,
    process: () => process,
    recycle: (id) => {
      recycled.push(id)
    },
  }
  const browse = new ExtensionBrowse(host, options.timing)
  const identity = { kind: 'extension', extId } as PaneIdentity
  const calls = { readAt: 0, entries: 0, chunk: 0 }
  hostConn.onRequest(BROWSE_READ_AT_METHOD, (params: unknown) => {
    calls.readAt += 1
    return browse.readAt(identity, hostConn, params)
  })
  hostConn.onRequest(BROWSE_ENTRIES_METHOD, ((params: unknown) => {
    calls.entries += 1
    return browse.entries(identity, hostConn, params)
  }) as never)
  hostConn.onRequest(BROWSE_CHUNK_METHOD, ((params: unknown) => {
    calls.chunk += 1
    return browse.chunk(identity, hostConn, params)
  }) as never)
  if (options.raw) options.raw(extConn)
  else listenForBrowse(extConn, new Map(Object.entries(options.providers ?? {})))
  hostConn.listen()
  extConn.listen()
  return {
    browse,
    hostConn,
    extConn,
    calls,
    recycled,
    dispose: () => {
      hostConn.dispose()
      extConn.dispose()
    },
  }
}
