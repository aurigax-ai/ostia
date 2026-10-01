import type { LspSessionInfo } from '@shared/languageServers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ServerEndpoint, createServerEndpoint } from '../../../test/mocks/lspTransport'
import { FakeModel, createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))

const { documentSaved, openDocument, resetLspClient } = await import('./client')

interface FakeServer {
  info: LspSessionInfo
  endpoint: ServerEndpoint
  notifications: { method: string; params: Record<string, unknown> }[]
}

interface Bridge {
  offered: LspSessionInfo[]
  servers: Map<string, FakeServer>
  addServer: (
    sessionId: string,
    serverKey: string,
    capabilities?: Record<string, unknown>,
  ) => FakeServer
  exit: (sessionId: string) => void
  serversChanged: () => void
}

function installBridge(): Bridge {
  const servers = new Map<string, FakeServer>()
  const onMessage = new Map<string, (message: unknown) => void>()
  const onExit = new Map<string, () => void>()
  const offered: LspSessionInfo[] = []
  let changed: () => void = () => {}
  const lsp = window.pine.lsp
  vi.mocked(lsp.open).mockImplementation(async () => [...offered])
  vi.mocked(lsp.onMessage).mockImplementation((sessionId, cb) => {
    onMessage.set(sessionId, cb)
    return () => onMessage.delete(sessionId)
  })
  vi.mocked(lsp.send).mockImplementation((sessionId, message) =>
    servers.get(sessionId)?.endpoint.receive(message),
  )
  vi.mocked(lsp.onExit).mockImplementation((sessionId, cb) => {
    onExit.set(sessionId, cb)
    return () => onExit.delete(sessionId)
  })
  vi.mocked(lsp.onServersChanged).mockImplementation((cb) => {
    changed = () => cb([])
    return () => {}
  })
  return {
    offered,
    servers,
    addServer: (sessionId, serverKey, capabilities = { textDocumentSync: 1 }) => {
      const endpoint = createServerEndpoint((message) => onMessage.get(sessionId)?.(message))
      const server: FakeServer = {
        info: {
          sessionId,
          serverKey,
          root: '/work',
          languageId: 'fake',
          initializationOptions: {},
        },
        endpoint,
        notifications: [],
      }
      endpoint.server.onRequest('initialize', () => ({ capabilities }))
      endpoint.server.onNotification((method, params) => {
        server.notifications.push({ method, params: params as Record<string, unknown> })
      })
      endpoint.server.listen()
      servers.set(sessionId, server)
      offered.push(server.info)
      return server
    },
    exit: (sessionId) => {
      const index = offered.findIndex((info) => info.sessionId === sessionId)
      if (index >= 0) offered.splice(index, 1)
      onExit.get(sessionId)?.()
    },
    serversChanged: () => changed(),
  }
}

function methods(server: FakeServer): string[] {
  return server.notifications.map((n) => n.method)
}

function markers(owner: string, uri: string): unknown[] | undefined {
  return fake.markers.get(`${owner} ${uri}`)
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const URI = 'file:///work/a.txt'
const diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  message: 'bad',
  severity: 1,
}

let bridge: Bridge

beforeEach(() => {
  bridge = installBridge()
  fake.markers.clear()
  fake.registrations.length = 0
})

afterEach(() => {
  resetLspClient()
})

describe('openDocument', () => {
  it('asks main with the pane and path, initializes each offered server once and opens the document', async () => {
    const server = bridge.addServer('s1', 'ext/fake')
    const model = new FakeModel('/work/a.txt', 'one')
    openDocument(model as never, 'pane-1')
    await flush()
    expect(window.pine.lsp.open).toHaveBeenCalledWith('pane-1', '/work/a.txt')
    expect(methods(server)).toEqual(['initialized', 'textDocument/didOpen'])
    expect(server.notifications[1].params).toMatchObject({
      textDocument: { uri: URI, languageId: 'fake', text: 'one' },
    })

    const second = new FakeModel('/work/b.txt', 'two')
    openDocument(second as never, 'pane-1')
    await flush()
    expect(
      server.endpoint.received.filter((m) => 'method' in m && m.method === 'initialize'),
    ).toHaveLength(1)
    expect(methods(server).filter((m) => m === 'textDocument/didOpen')).toHaveLength(2)
  })

  it('shows a server’s diagnostics as markers under that server’s own owner', async () => {
    const first = bridge.addServer('s1', 'ext/one')
    const second = bridge.addServer('s2', 'ext/two')
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    first.endpoint.server.sendNotification('textDocument/publishDiagnostics', {
      uri: URI,
      diagnostics: [diagnostic],
    })
    second.endpoint.server.sendNotification('textDocument/publishDiagnostics', {
      uri: URI,
      diagnostics: [diagnostic, { ...diagnostic, message: 'worse' }],
    })
    await flush()
    expect(markers('lsp:ext/one', URI)).toHaveLength(1)
    expect(markers('lsp:ext/two', URI)).toHaveLength(2)
    expect(markers('lsp:ext/one', URI)?.[0]).toMatchObject({ message: 'bad', severity: 8 })
  })

  it('ignores diagnostics for a document it did not open with that server', async () => {
    const server = bridge.addServer('s1', 'ext/fake')
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    server.endpoint.server.sendNotification('textDocument/publishDiagnostics', {
      uri: 'file:///work/other.txt',
      diagnostics: [diagnostic],
    })
    await flush()
    expect(fake.markers.size).toBe(0)
  })

  it('keeps the document open while any editor holds it, then closes it, clears markers and releases the session', async () => {
    const server = bridge.addServer('s1', 'ext/fake')
    const model = new FakeModel('/work/a.txt', 'one')
    const releaseFirst = openDocument(model as never, 'pane-1')
    const releaseSecond = openDocument(model as never, 'pane-2')
    await flush()
    server.endpoint.server.sendNotification('textDocument/publishDiagnostics', {
      uri: URI,
      diagnostics: [diagnostic],
    })
    await flush()
    releaseFirst()
    releaseFirst()
    await flush()
    expect(methods(server)).not.toContain('textDocument/didClose')
    expect(markers('lsp:ext/fake', URI)).toHaveLength(1)
    releaseSecond()
    await flush()
    expect(methods(server).at(-1)).toBe('textDocument/didClose')
    expect(markers('lsp:ext/fake', URI)).toEqual([])
    const released = vi.mocked(window.pine.lsp.release).mock.calls.map(([id]) => id)
    const opened = vi.mocked(window.pine.lsp.open).mock.calls.length
    expect(released).toHaveLength(opened)
    expect(new Set(released)).toEqual(new Set(['s1']))
  })

  it('opens the document again with its current text after it was closed', async () => {
    const server = bridge.addServer('s1', 'ext/fake')
    const model = new FakeModel('/work/a.txt', 'one')
    openDocument(model as never, 'pane-1')()
    await flush()
    model.edit({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, 'changed')
    openDocument(model as never, 'pane-1')
    await flush()
    const opens = server.notifications.filter((n) => n.method === 'textDocument/didOpen')
    expect(opens.at(-1)?.params).toMatchObject({ textDocument: { text: 'changed' } })
    expect(methods(server)).not.toContain('textDocument/didChange')
  })

  it('closes the document when its model is disposed', async () => {
    const server = bridge.addServer('s1', 'ext/fake')
    const model = new FakeModel('/work/a.txt', 'one')
    openDocument(model as never, 'pane-1')
    await flush()
    model.dispose()
    await flush()
    expect(methods(server).at(-1)).toBe('textDocument/didClose')
    expect(window.pine.lsp.release).toHaveBeenCalledWith('s1')
  })

  it('releases a session whose server fails to initialize and attaches nothing', async () => {
    const server = bridge.addServer('s1', 'ext/fake')
    server.endpoint.server.onRequest('initialize', () => {
      throw new Error('cannot start')
    })
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    expect(methods(server)).toEqual([])
    expect(window.pine.lsp.release).toHaveBeenCalledWith('s1')
    expect(fake.registrations).toHaveLength(0)
  })
})

describe('providers', () => {
  it('registers only what the server reports, once per server and language', async () => {
    bridge.addServer('s1', 'ext/fake', {
      textDocumentSync: 1,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['.', '#'] },
    })
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    openDocument(new FakeModel('/work/b.txt', 'two') as never, 'pane-1')
    await flush()
    expect(fake.registrations.map((r) => [r.kind, r.language])).toEqual([
      ['CompletionItemProvider', 'plaintext'],
      ['HoverProvider', 'plaintext'],
    ])
    expect(fake.registrations[0].provider.triggerCharacters).toEqual(['.', '#'])
  })

  it('answers through the session the document is attached to', async () => {
    const server = bridge.addServer('s1', 'ext/fake', { textDocumentSync: 1, hoverProvider: true })
    server.endpoint.server.onRequest('textDocument/hover', (params) => ({
      contents: { kind: 'markdown', value: `hover ${JSON.stringify(params.position)}` },
    }))
    const model = new FakeModel('/work/a.txt', 'one')
    openDocument(model as never, 'pane-1')
    await flush()
    const [hover] = fake.active('HoverProvider')
    const provide = hover.provider.provideHover as (
      model: unknown,
      position: unknown,
    ) => Promise<{ contents: { value: string }[] } | null>
    expect(await provide(model, { lineNumber: 1, column: 2 })).toEqual({
      contents: [{ value: 'hover {"line":0,"character":1}' }],
    })
    expect(
      await provide(new FakeModel('/work/unopened.txt', ''), { lineNumber: 1, column: 1 }),
    ).toBeNull()
  })
})

describe('server lifecycle', () => {
  it('clears markers and providers when the server exits and attaches to its replacement', async () => {
    const first = bridge.addServer('s1', 'ext/fake', { textDocumentSync: 1, hoverProvider: true })
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    first.endpoint.server.sendNotification('textDocument/publishDiagnostics', {
      uri: URI,
      diagnostics: [diagnostic],
    })
    await flush()
    const replacement = bridge.addServer('s2', 'ext/fake', { textDocumentSync: 1 })
    bridge.exit('s1')
    await flush()
    expect(markers('lsp:ext/fake', URI)).toEqual([])
    expect(methods(replacement)).toEqual(['initialized', 'textDocument/didOpen'])
    expect(fake.active('HoverProvider')).toHaveLength(0)
  })

  it('stays detached when the crashed server is not offered again', async () => {
    bridge.addServer('s1', 'ext/fake', { textDocumentSync: 1, hoverProvider: true })
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    bridge.exit('s1')
    await flush()
    expect(fake.active('HoverProvider')).toHaveLength(0)
    expect(vi.mocked(window.pine.lsp.open).mock.calls).toHaveLength(2)
  })

  it('attaches open documents to a server that became available, without holding the others twice', async () => {
    const first = bridge.addServer('s1', 'ext/one')
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    const second = bridge.addServer('s2', 'ext/two')
    bridge.serversChanged()
    await flush()
    expect(methods(second)).toEqual(['initialized', 'textDocument/didOpen'])
    expect(methods(first).filter((m) => m === 'textDocument/didOpen')).toHaveLength(1)
    expect(vi.mocked(window.pine.lsp.release).mock.calls).toEqual([['s1']])
  })

  it('moves a document to the new session when main replaced a restarted server', async () => {
    const first = bridge.addServer('s1', 'ext/fake')
    openDocument(new FakeModel('/work/a.txt', 'one') as never, 'pane-1')
    await flush()
    bridge.offered.length = 0
    const second = bridge.addServer('s2', 'ext/fake')
    bridge.serversChanged()
    await flush()
    expect(methods(first).at(-1)).toBe('textDocument/didClose')
    expect(methods(second)).toEqual(['initialized', 'textDocument/didOpen'])
  })

  it('tells every attached server that asked for it when the file is saved', async () => {
    const server = bridge.addServer('s1', 'ext/fake', {
      textDocumentSync: { change: 1, save: true },
    })
    const model = new FakeModel('/work/a.txt', 'one')
    openDocument(model as never, 'pane-1')
    await flush()
    documentSaved(model as never)
    await flush()
    expect(server.notifications.at(-1)).toEqual({
      method: 'textDocument/didSave',
      params: { textDocument: { uri: URI } },
    })
  })
})
