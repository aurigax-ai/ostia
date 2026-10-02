import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FAKE_LSP_BIN,
  installFakeLanguageExtension,
} from '../../test/fixtures/lsp/installFakeExtension'
import type { LanguageServerContribution } from '../shared/languageServers'
import { readManifest } from './extensionManifest'
import { TreeWatches } from './fileWatch'
import { type LanguageServerSource, LanguageServers } from './languageServers'
import { programPath } from './systemRequirements'

interface Posted {
  channel: string
  message: Record<string, unknown> | undefined
}

let tmp: string
let workDir: string
let extensionDir: string
let servers: LanguageServers
let sources: LanguageServerSource[]
let posts: Posted[]
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

async function initialize(sessionId: string): Promise<Record<string, unknown>> {
  servers.send('w1', sessionId, {
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
  servers.send('w1', sessionId, { jsonrpc: '2.0', method: 'initialized', params: {} })
  return messages(sessionId).find((m) => m.id === 1) as Record<string, unknown>
}

function didOpen(sessionId: string, file: string, text: string): void {
  servers.send('w1', sessionId, {
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

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pine-lsp-int-')))
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
  servers = new LanguageServers({
    sources: () => sources,
    nodePath: process.execPath,
    env: () => ({ ...process.env, PINE_TOKEN: 'must-not-leak', PINE_SOCKET: '/nope' }),
    pane: (paneId) => (paneId === 'p1' ? { windowId: 'w1', workspaceId: 'ws1' } : undefined),
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
    post: (_windowId, channel, message) =>
      posted.push({ channel, message: message as Record<string, unknown> | undefined }),
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
  it('starts from the extension folder without Pine’s environment and speaks LSP both ways', async () => {
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
      serverInfo: { name: 'pine-fake-lsp' },
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
      pineEnv: [],
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
        program: 'pine-fake-lsp',
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
      run: { program: 'pine-fake-lsp', args: ['--caps=hover', '--name=from-path'] },
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
})
