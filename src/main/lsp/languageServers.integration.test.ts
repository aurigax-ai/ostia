import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_LSP_BIN,
  installFakeLanguageExtension,
} from '../../../test/fixtures/lsp/installFakeExtension'
import { type EditorLanguage, languageForPath } from '../../shared/editorLanguages'
import type { LanguageServerContribution } from '../../shared/languageServers'
import { readManifest } from '../extensions/extensionManifest'
import { TreeWatches } from '../files/fileWatch'
import { programPath } from '../platform/systemRequirements'
import { loadEditorLanguages } from './editorLanguages'
import { type LanguageServerSource, LanguageServers } from './languageServers'
import { chooseServerProgram } from './languageServersIpc'
import { ServerOverrides } from './serverOverrides'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

interface Posted {
  windowId: string
  channel: string
  message: Record<string, unknown> | undefined
}

let tmp: string
let workDir: string
let extensionDir: string
let servers: LanguageServers
let sources: LanguageServerSource[]
let posts: Posted[]
let editorLanguages: EditorLanguage[]
const treeWatches = new TreeWatches({
  confine: (dir) => (dir.startsWith(tmp) ? dir : null),
  debounceMs: 30,
})

function record(root: string): { method: string; [key: string]: unknown }[] {
  return readFileSync(join(root, '.fake-lsp-record.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function messages(sessionId: string): Record<string, unknown>[] {
  return posts
    .filter((p) => p.channel === `lsp:msg:${sessionId}` && p.message)
    .map((p) => p.message as Record<string, unknown>)
}

async function initialize(sessionId: string, windowId = 'w1'): Promise<Record<string, unknown>> {
  servers.send(windowId, sessionId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: null,
      rootUri: null,
      capabilities: { workspace: { configuration: true } },
    },
  })
  await vi.waitFor(() => expect(messages(sessionId).some((m) => m.id === 1)).toBe(true), {
    timeout: 10_000,
  })
  servers.send(windowId, sessionId, { jsonrpc: '2.0', method: 'initialized', params: {} })
  return messages(sessionId).find((m) => m.id === 1) as Record<string, unknown>
}

function didOpen(sessionId: string, file: string, text: string, windowId = 'w1'): void {
  servers.send(windowId, sessionId, {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri: pathToFileURL(file).href, languageId: 'fake', version: 1, text },
    },
  })
}

function diagnostics(sessionId: string): string[] {
  const published = messages(sessionId).filter(
    (m) => m.method === 'textDocument/publishDiagnostics',
  )
  const last = published.at(-1)?.params as { diagnostics: { message: string }[] } | undefined
  return (last?.diagnostics ?? []).map((d) => d.message)
}

async function request(
  sessionId: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  servers.send('w1', sessionId, { jsonrpc: '2.0', id, method, params })
  await vi.waitFor(() => expect(messages(sessionId).some((m) => m.id === id)).toBe(true), {
    timeout: 10_000,
  })
  return messages(sessionId).find((m) => m.id === id)?.result as Record<string, unknown>
}

function starts(): number {
  return record(workDir).filter((entry) => entry.method === '$start').length
}

function exited(sessionId: string): boolean {
  return posts.some((p) => p.channel === `lsp:exit:${sessionId}`)
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-lsp-int-')))
  workDir = join(tmp, 'work')
  mkdirSync(workDir)
  writeFileSync(join(workDir, 'notes.txt'), 'hello')
  extensionDir = installFakeLanguageExtension(join(tmp, 'extensions'))
  const manifest = readManifest(extensionDir)
  if (!manifest.ok) throw new Error(manifest.error)
  const [server] = manifest.manifest.contributes.languageServers ?? []
  sources = [
    {
      extId: manifest.manifest.id,
      extName: manifest.manifest.name,
      dir: extensionDir,
      builtin: false,
      state: 'on',
      server,
      settingValues: { mode: 'loud' },
    },
  ]
  const posted: Posted[] = []
  posts = posted
  editorLanguages = []
  servers = new LanguageServers({
    sources: () => sources,
    nodePath: process.execPath,
    env: () => ({ ...process.env, OSTIA_TOKEN: 'must-not-leak', OSTIA_SOCKET: '/nope' }),
    pane: (paneId) =>
      paneId === 'p1'
        ? { windowId: 'w1', workspaceId: 'ws1' }
        : paneId === 'p2'
          ? { windowId: 'w2', workspaceId: 'ws2' }
          : undefined,
    confine: (path) => (path.startsWith(tmp) ? path : null),
    workDir: () => workDir,
    roots: () => [tmp],
    sandbox: {
      owner: () => null,
      readable: () => true,
      wrap: async (_workspaceId, command) => command,
      env: (_workspaceId, env) => env,
    },
    findProgram: (program) => programPath(program, FAKE_LSP_BIN),
    languageOf: (path) => languageForPath(path, editorLanguages),
    managed: {
      canFetch: () => false,
      executable: () => null,
      folder: () => '',
      fetch: async () => '',
      remove: () => {},
      retain: () => {},
    },
    registerRequirements: () => {},
    watchTree: (root, onChange) => treeWatches.watch(root, onChange),
    post: (windowId, channel, message) =>
      posted.push({ windowId, channel, message: message as Record<string, unknown> | undefined }),
    changed: () => {},
    idleMs: 50,
    restartDelayMs: 10,
  })
})

afterEach(() => {
  servers.stopAll()
  treeWatches.closeAll()
  rmSync(tmp, { recursive: true, force: true })
})

describe('a real language server process', () => {
  it('starts from the extension folder without Ostia’s environment and speaks LSP both ways', async () => {
    const file = join(workDir, 'notes.txt')
    const [session] = await servers.open('w1', 'p1', file)
    expect(session).toMatchObject({
      serverKey: 'fake-lang/fake',
      root: workDir,
      languageId: 'fake',
    })
    expect(session.initializationOptions).toEqual({ extension: extensionDir, root: workDir })

    const initialized = await initialize(session.sessionId)
    expect(initialized.result).toMatchObject({
      serverInfo: { name: 'ostia-fake-lsp' },
      capabilities: { hoverProvider: true, textDocumentSync: { change: 2 } },
    })

    didOpen(session.sessionId, file, 'first line\nan ERROR here\nCONFIG fake\n')
    await vi.waitFor(
      () =>
        expect(diagnostics(session.sessionId)).toEqual([
          'fake error on line 2',
          `config fake = {"mode":"loud","root":"${workDir}"}`,
        ]),
      { timeout: 10_000 },
    )

    const [start] = record(workDir)
    expect(start).toMatchObject({
      method: '$start',
      cwd: workDir,
      ostiaEnv: [],
      runAsNode: '1',
      argv: [`--record=${workDir}/.fake-lsp-record.jsonl`, '--sync=incremental'],
    })
    expect(servers.log('fake-lang/fake').entries.map((e) => e.kind)).toEqual([
      'start',
      'initialized',
    ])
  })

  it('exits by shutdown and exit after its last document is released', async () => {
    const file = join(workDir, 'notes.txt')
    const [session] = await servers.open('w1', 'p1', file)
    await initialize(session.sessionId)
    servers.release('w1', session.sessionId)
    await vi.waitFor(
      () => expect(posts.some((p) => p.channel === `lsp:exit:${session.sessionId}`)).toBe(true),
      { timeout: 10_000 },
    )
    expect(record(workDir).map((entry) => entry.method)).toEqual([
      '$start',
      'initialize',
      'initialized',
      'workspace/didChangeConfiguration',
      'shutdown',
      'exit',
    ])
    expect(servers.log('fake-lang/fake').entries.at(-1)).toMatchObject({ kind: 'exit', code: 0 })
    expect(servers.servers()[0]).toMatchObject({ status: 'idle', folders: 0 })
  })

  it('comes back after a crash when the document is opened again', async () => {
    const file = join(workDir, 'notes.txt')
    const [first] = await servers.open('w1', 'p1', file)
    await initialize(first.sessionId)
    didOpen(first.sessionId, file, 'CRASH now')
    await vi.waitFor(
      () => expect(posts.some((p) => p.channel === `lsp:exit:${first.sessionId}`)).toBe(true),
      { timeout: 10_000 },
    )
    expect(servers.log('fake-lang/fake').entries.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'exit', code: 1 }),
      expect.objectContaining({ kind: 'restart', attempt: 1 }),
    ])
    const [second] = await servers.open('w1', 'p1', file)
    expect(second.sessionId).not.toBe(first.sessionId)
    await initialize(second.sessionId)
    didOpen(second.sessionId, file, 'WARN only')
    await vi.waitFor(
      () => expect(diagnostics(second.sessionId)).toEqual(['fake warning on line 1']),
      { timeout: 10_000 },
    )
  })

  it('tells a server that registered file watchers about matching files changed under its root', async () => {
    const program: LanguageServerContribution = {
      id: 'watcher',
      name: 'Fake watcher',
      languages: ['plaintext'],
      run: {
        program: 'ostia-fake-lsp',
        args: ['--record={root}/.fake-lsp-record.jsonl', '--watch=**/*.cfg'],
      },
      rootMarkers: [],
    }
    sources = [{ ...sources[0], server: program }]
    const [session] = await servers.open('w1', 'p1', join(workDir, 'notes.txt'))
    await initialize(session.sessionId)
    const registration = (): Record<string, unknown> | undefined =>
      messages(session.sessionId).find((m) => m.method === 'client/registerCapability')
    await vi.waitFor(() => expect(registration()).toBeDefined(), { timeout: 10_000 })
    servers.send('w1', session.sessionId, { jsonrpc: '2.0', id: registration()?.id, result: null })
    await vi.waitFor(
      () => expect(record(workDir).some((entry) => entry.method === '$registered')).toBe(true),
      { timeout: 10_000 },
    )

    mkdirSync(join(workDir, 'conf'))
    writeFileSync(join(workDir, 'conf', 'app.cfg'), 'a=1')
    writeFileSync(join(workDir, 'conf', 'ignored.txt'), 'x')
    const watched = (): { uri: string; type: number }[] =>
      record(workDir)
        .filter((entry) => entry.method === 'workspace/didChangeWatchedFiles')
        .flatMap((entry) => (entry.params as { changes: { uri: string; type: number }[] }).changes)
    await vi.waitFor(
      () =>
        expect(watched()).toEqual([
          { uri: pathToFileURL(join(workDir, 'conf', 'app.cfg')).href, type: 1 },
        ]),
      { timeout: 10_000 },
    )

    servers.send('w1', session.sessionId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'workspace/executeCommand',
      params: { command: 'fake.unregister', arguments: ['watch'] },
    })
    const unregistration = (): Record<string, unknown> | undefined =>
      messages(session.sessionId).find((m) => m.method === 'client/unregisterCapability')
    await vi.waitFor(() => expect(unregistration()).toBeDefined(), { timeout: 10_000 })
    expect(treeWatches.watchedDirs(workDir)).toEqual([])
  })

  it('runs a program server found on PATH', async () => {
    const program: LanguageServerContribution = {
      id: 'program',
      name: 'Fake program',
      languages: ['plaintext'],
      run: { program: 'ostia-fake-lsp', args: ['--caps=hover', '--name=from-path'] },
      rootMarkers: [],
    }
    sources = [{ ...sources[0], server: program }]
    const [session] = await servers.open('w1', 'p1', join(workDir, 'notes.txt'))
    const initialized = await initialize(session.sessionId)
    expect(initialized.result).toMatchObject({ serverInfo: { name: 'from-path' } })
    const { capabilities } = initialized.result as { capabilities: Record<string, unknown> }
    expect(capabilities.hoverProvider).toBe(true)
    expect(capabilities.completionProvider).toBeUndefined()
  })

  it('an extension’s language server gives the editor a diagnostic, hover and completion', async () => {
    const file = join(workDir, 'notes.txt')
    const uri = pathToFileURL(file).href
    const [session] = await servers.open('w1', 'p1', file)
    await initialize(session.sessionId)
    didOpen(session.sessionId, file, 'greeting ERROR here\nsecond line\n')
    await vi.waitFor(
      () => expect(diagnostics(session.sessionId)).toEqual(['fake error on line 1']),
      { timeout: 10_000 },
    )
    expect(
      await request(session.sessionId, 2, 'textDocument/hover', {
        textDocument: { uri },
        position: { line: 0, character: 2 },
      }),
    ).toMatchObject({ contents: { value: 'fake hover: **greeting**' } })
    const completion = await request(session.sessionId, 3, 'textDocument/completion', {
      textDocument: { uri },
      position: { line: 1, character: 11 },
    })
    expect(completion.items).toMatchObject([
      { label: 'fakeAlpha' },
      {
        label: 'fakeEdit',
        textEdit: { newText: 'fakeEdited' },
        additionalTextEdits: [{ newText: 'imported by fake\n' }],
      },
      { label: 'fakeSnippet' },
    ])
    const [again] = await servers.open('w1', 'p1', file)
    expect(again.sessionId).toBe(session.sessionId)
    expect(servers.servers()[0]).toMatchObject({
      extName: 'Fake language',
      languages: ['plaintext'],
      status: 'running',
      folders: 1,
    })
    expect(starts()).toBe(1)
  })

  it('a missing program is offered for install, with the exact command shown before anything runs', async () => {
    const manifest = readManifest(extensionDir)
    if (!manifest.ok) throw new Error(manifest.error)
    sources = (manifest.manifest.contributes.languageServers ?? []).map((server) => ({
      ...sources[0],
      server,
    }))
    const offered = await servers.open('w1', 'p1', join(workDir, 'notes.txt'))
    expect(offered.map((session) => session.serverKey)).toEqual(['fake-lang/fake'])
    expect(servers.servers().find((server) => server.serverId === 'absent')).toMatchObject({
      name: 'Absent server',
      status: 'program-missing',
      program: 'ostia-absent-lsp',
      requirement: 'lsp:fake-lang/absent',
    })
  })

  it('switching a server off stops its process, and Restart starts a fresh one', async () => {
    const file = join(workDir, 'notes.txt')
    const [first] = await servers.open('w1', 'p1', file)
    await initialize(first.sessionId)
    didOpen(first.sessionId, file, 'an ERROR\n')
    await vi.waitFor(() => expect(diagnostics(first.sessionId)).toEqual(['fake error on line 1']), {
      timeout: 10_000,
    })

    await servers.restart('fake-lang/fake')
    expect(exited(first.sessionId)).toBe(true)
    const [second] = await servers.open('w1', 'p1', file)
    expect(second.sessionId).not.toBe(first.sessionId)
    await initialize(second.sessionId)
    expect(servers.servers()[0]).toMatchObject({ status: 'running', folders: 1 })
    const lifecycle = [
      '$start',
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'shutdown',
      'exit',
    ]
    expect(
      record(workDir)
        .map((entry) => entry.method)
        .filter((method) => lifecycle.includes(method))
        .slice(0, 7),
    ).toEqual([...lifecycle, '$start'])

    sources = [{ ...sources[0], state: 'off' }]
    servers.refresh()
    expect(servers.servers()[0].status).toBe('off')
    await vi.waitFor(() => expect(exited(second.sessionId)).toBe(true), { timeout: 10_000 })
    expect(record(workDir).filter((entry) => entry.method === 'exit')).toHaveLength(2)
    expect(servers.log('fake-lang/fake').entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'initialized', name: 'ostia-fake-lsp', version: '1.0.0' }),
        expect.objectContaining({ kind: 'stop', reason: 'off' }),
      ]),
    )
    expect(await servers.open('w1', 'p1', file)).toEqual([])
    expect(starts()).toBe(2)
  })

  it('a crashing server is restarted five times, then reported as crashed until the human restarts it', async () => {
    const file = join(workDir, 'boom.txt')
    writeFileSync(file, 'CRASH on open\n')
    for (let attempt = 0; attempt < 8; attempt++) {
      const [session] = await servers.open('w1', 'p1', file)
      if (!session) break
      await initialize(session.sessionId)
      didOpen(session.sessionId, file, 'CRASH on open\n')
      await vi.waitFor(() => expect(exited(session.sessionId)).toBe(true), { timeout: 10_000 })
    }
    expect(servers.servers()[0].status).toBe('crashed')
    expect(starts()).toBe(6)

    writeFileSync(file, 'calm now\n')
    await servers.restart('fake-lang/fake')
    expect(await servers.open('w1', 'p1', file)).toHaveLength(1)
    await vi.waitFor(() => expect(starts()).toBe(7), { timeout: 10_000 })
  })

  it('two windows showing the same folder each get their own server and their own diagnostics', async () => {
    const one = join(workDir, 'one.txt')
    const two = join(workDir, 'two.txt')
    const [first] = await servers.open('w1', 'p1', one)
    await initialize(first.sessionId)
    didOpen(first.sessionId, one, 'first ERROR\n')
    const [second] = await servers.open('w2', 'p2', two)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.root).toBe(first.root)
    await initialize(second.sessionId, 'w2')
    didOpen(second.sessionId, two, 'second ERROR\nand another ERROR\n', 'w2')
    await vi.waitFor(
      () => {
        expect(diagnostics(first.sessionId)).toEqual(['fake error on line 1'])
        expect(diagnostics(second.sessionId)).toEqual([
          'fake error on line 1',
          'fake error on line 2',
        ])
      },
      { timeout: 10_000 },
    )
    const windows = (sessionId: string): string[] => [
      ...new Set(posts.filter((p) => p.channel === `lsp:msg:${sessionId}`).map((p) => p.windowId)),
    ]
    expect(windows(first.sessionId)).toEqual(['w1'])
    expect(windows(second.sessionId)).toEqual(['w2'])
    expect(starts()).toBe(2)
  })

  it('an extension adds an editor language: its grammar colours the file and its server is started for it', async () => {
    const dir = installFakeLanguageExtension(join(tmp, 'extensions'), 'fake-grammar')
    const manifest = readManifest(dir)
    if (!manifest.ok) throw new Error(manifest.error)
    const { id, name, contributes } = manifest.manifest
    const errors: string[] = []
    editorLanguages = loadEditorLanguages({
      languages: () =>
        (contributes.editorLanguages ?? []).map((language) => ({ extId: id, dir, language })),
      onError: (_extId, error) => errors.push(error),
    })
    expect(errors).toEqual([])
    expect(editorLanguages.map((language) => language.id)).toEqual(['fakelang'])
    const [server] = contributes.languageServers ?? []
    sources = [
      { extId: id, extName: name, dir, builtin: false, state: 'on', server, settingValues: {} },
    ]

    const file = join(workDir, 'demo.fake')
    const [session] = await servers.open('w1', 'p1', file)
    expect(session.languageId).toBe('fakelang')
    await initialize(session.sessionId)
    didOpen(session.sessionId, file, 'fn alpha KEYWORD\nplain ERROR here\n')
    await vi.waitFor(
      () => expect(diagnostics(session.sessionId)).toEqual(['fake error on line 2']),
      { timeout: 10_000 },
    )
    expect(
      await request(session.sessionId, 2, 'textDocument/hover', {
        textDocument: { uri: pathToFileURL(file).href },
        position: { line: 0, character: 1 },
      }),
    ).toMatchObject({ contents: { value: 'fake hover: **fn**' } })
    const [byName] = await servers.open('w1', 'p1', join(workDir, 'Fakefile'))
    expect(byName.sessionId).toBe(session.sessionId)
    expect(servers.servers()[0]).toMatchObject({
      name: 'Fake grammar server',
      languages: ['fakelang'],
      status: 'running',
      folders: 1,
    })
  })

  it('the human gives a server their own program in Settings; a file that cannot run is refused', async () => {
    const overrides = new ServerOverrides(join(tmp, 'language-server-programs.json'))
    const deps = {
      servers,
      setEnabled: () => {},
      setOverride: (key: string, raw: unknown) => overrides.choose(key, raw),
    }
    const file = join(workDir, 'notes.txt')
    expect(chooseServerProgram(deps, 'fake-lang/fake', { path: file, args: [] }).problem).toBe(
      'not-executable',
    )
    const program = join(FAKE_LSP_BIN, 'ostia-fake-lsp')
    expect(
      chooseServerProgram(deps, 'fake-lang/fake', {
        path: program,
        args: ['--name=chosen-by-human'],
      }).problem,
    ).toBeUndefined()
    sources = [{ ...sources[0], override: overrides.get('fake-lang/fake') }]
    expect(servers.servers()[0]).toMatchObject({
      override: { path: program },
      binary: { source: 'override' },
    })

    const [session] = await servers.open('w1', 'p1', file)
    await initialize(session.sessionId)
    didOpen(session.sessionId, file, 'an ERROR\n')
    await vi.waitFor(
      () => expect(diagnostics(session.sessionId)).toEqual(['fake error on line 1']),
      { timeout: 10_000 },
    )
    const [start] = record(workDir)
    expect((start.argv as string[]).at(-1)).toBe('--name=chosen-by-human')
    expect(start.runAsNode).toBeNull()
    expect(servers.servers()[0]).toMatchObject({ status: 'running', folders: 1 })
    expect(servers.log('fake-lang/fake').entries).toContainEqual(
      expect.objectContaining({ kind: 'initialized', name: 'chosen-by-human' }),
    )
  })
})
