import { afterEach, describe, expect, it, vi } from 'vitest'
import { CancellationTokenSource } from 'vscode-jsonrpc/browser'
import { type LinkedTransport, createLinkedTransport } from '../../../test/mocks/lspTransport'
import { FakeModel, createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))

const { LspSession } = await import('./session')

const info = {
  sessionId: 's1',
  serverKey: 'ext/fake',
  root: '/work/proj',
  editRoot: '/work/proj',
  languageId: 'fake',
  initializationOptions: { flavor: 'test' },
}

interface Started {
  session: InstanceType<typeof LspSession>
  link: LinkedTransport
  diagnostics: { uri: string; count: number }[]
  closed: ReturnType<typeof vi.fn>
  notifications: { method: string; params: unknown }[]
}

const open: InstanceType<typeof LspSession>[] = []

async function start(capabilities: Record<string, unknown>): Promise<Started> {
  const link = createLinkedTransport()
  const notifications: { method: string; params: unknown }[] = []
  link.server.onRequest('initialize', () => ({ capabilities }))
  link.server.onNotification((method, params) => {
    notifications.push({ method, params })
  })
  link.server.listen()
  const diagnostics: { uri: string; count: number }[] = []
  const closed = vi.fn()
  const session = new LspSession(info, link.clientReader, link.clientWriter, {
    onDiagnostics: (uri, list) => diagnostics.push({ uri, count: list.length }),
    onClosed: closed,
  })
  open.push(session)
  await session.initialize()
  return { session, link, diagnostics, closed, notifications }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  for (const session of open.splice(0)) session.dispose()
})

describe('LspSession', () => {
  it('initializes with the root, the manifest’s options and its capabilities, then confirms', async () => {
    const { link, notifications, session } = await start({ hoverProvider: true })
    const [initialize] = link.received as unknown as {
      method: string
      params: Record<string, unknown>
    }[]
    expect(initialize.method).toBe('initialize')
    expect(initialize.params).toMatchObject({
      processId: null,
      rootUri: 'file:///work/proj',
      initializationOptions: { flavor: 'test' },
      workspaceFolders: [{ uri: 'file:///work/proj', name: 'proj' }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true } },
    })
    await settled()
    expect(notifications.map((n) => n.method)).toEqual(['initialized'])
    expect(session.capabilities).toEqual({ hoverProvider: true })
  })

  it('opens a document with the server’s language id and sends whole text when the server asks for full sync', async () => {
    const { session, notifications } = await start({ textDocumentSync: 1 })
    const model = new FakeModel('/work/proj/a.txt', 'one\ntwo')
    session.openDocument(model as never, 'fake')
    model.edit({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, 'ONE')
    await settled()
    expect(notifications.slice(1)).toEqual([
      {
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: 'file:///work/proj/a.txt',
            languageId: 'fake',
            version: 1,
            text: 'one\ntwo',
          },
        },
      },
      {
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: 'file:///work/proj/a.txt', version: 2 },
          contentChanges: [{ text: 'ONE\ntwo' }],
        },
      },
    ])
  })

  it('sends only the changed range when the server takes incremental sync', async () => {
    const { session, notifications } = await start({ textDocumentSync: { change: 2 } })
    const model = new FakeModel('/work/proj/a.txt', 'one\ntwo')
    session.openDocument(model as never, 'fake')
    model.edit({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, 'TWO!')
    await settled()
    expect(notifications.at(-1)).toEqual({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: 'file:///work/proj/a.txt', version: 2 },
        contentChanges: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
            rangeLength: 3,
            text: 'TWO!',
          },
        ],
      },
    })
  })

  it('sends no changes to a server that does not sync documents', async () => {
    const { session, notifications } = await start({})
    const model = new FakeModel('/work/proj/a.txt', 'one')
    session.openDocument(model as never, 'fake')
    model.edit({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, 'x')
    await settled()
    expect(notifications.map((n) => n.method)).toEqual(['initialized', 'textDocument/didOpen'])
  })

  it('closes a document once and stops following its edits', async () => {
    const { session, notifications } = await start({ textDocumentSync: 1 })
    const model = new FakeModel('/work/proj/a.txt', 'one')
    session.openDocument(model as never, 'fake')
    session.openDocument(model as never, 'fake')
    session.closeDocument('file:///work/proj/a.txt')
    session.closeDocument('file:///work/proj/a.txt')
    model.edit({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, 'x')
    await settled()
    expect(notifications.map((n) => n.method)).toEqual([
      'initialized',
      'textDocument/didOpen',
      'textDocument/didClose',
    ])
    expect(session.hasDocument('file:///work/proj/a.txt')).toBe(false)
  })

  it('tells the server about a save only when it asked for saves', async () => {
    const withSave = await start({ textDocumentSync: { change: 1, save: { includeText: false } } })
    const model = new FakeModel('/work/proj/a.txt', 'one')
    withSave.session.openDocument(model as never, 'fake')
    withSave.session.documentSaved('file:///work/proj/a.txt')
    withSave.session.documentSaved('file:///work/proj/other.txt')
    await settled()
    expect(withSave.notifications.filter((n) => n.method === 'textDocument/didSave')).toEqual([
      {
        method: 'textDocument/didSave',
        params: { textDocument: { uri: 'file:///work/proj/a.txt' } },
      },
    ])

    const without = await start({ textDocumentSync: 1 })
    without.session.openDocument(new FakeModel('/work/proj/b.txt', 'x') as never, 'fake')
    without.session.documentSaved('file:///work/proj/b.txt')
    await settled()
    expect(without.notifications.some((n) => n.method === 'textDocument/didSave')).toBe(false)
  })

  it('passes diagnostics on and answers the server’s folder and registration requests', async () => {
    const { link, diagnostics } = await start({})
    link.server.sendNotification('textDocument/publishDiagnostics', {
      uri: 'file:///work/proj/a.txt',
      diagnostics: [{ message: 'x' }],
    })
    expect(await link.server.sendRequest('workspace/workspaceFolders')).toEqual([
      { uri: 'file:///work/proj', name: 'proj' },
    ])
    expect(
      await link.server.sendRequest('client/registerCapability', { registrations: [] }),
    ).toBeNull()
    expect(await link.server.sendRequest('window/workDoneProgress/create', { token: 1 })).toBeNull()
    expect(diagnostics).toEqual([{ uri: 'file:///work/proj/a.txt', count: 1 }])
  })

  it('returns null for a request the server fails, and cancels one the editor gave up on', async () => {
    const { session, link } = await start({})
    link.server.onRequest('custom/fail', () => {
      throw new Error('no')
    })
    let cancelled = false
    link.server.onRequest(
      'custom/slow',
      (_params, token) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => {
            cancelled = true
            resolve(null)
          })
        }),
    )
    expect(await session.request('custom/fail', {})).toBeNull()
    const source = new CancellationTokenSource()
    const pending = session.request('custom/slow', {}, source.token)
    await settled()
    source.cancel()
    expect(await pending).toBeNull()
    expect(cancelled).toBe(true)
  })

  it('goes quiet after it is disposed and reports that once', async () => {
    const { session, closed, notifications } = await start({ textDocumentSync: 1 })
    const model = new FakeModel('/work/proj/a.txt', 'one')
    session.openDocument(model as never, 'fake')
    session.dispose()
    session.dispose()
    model.edit({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, 'x')
    expect(await session.request('custom/any', {})).toBeNull()
    await settled()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(notifications.map((n) => n.method)).toEqual(['initialized', 'textDocument/didOpen'])
  })
})
