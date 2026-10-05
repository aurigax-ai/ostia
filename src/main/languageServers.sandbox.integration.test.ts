import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { installFakeLanguageExtension } from '../../test/fixtures/lsp/installFakeExtension'
import { DEFAULT_SANDBOX_GLOBALS } from '../shared/sandbox'
import { readManifest } from './extensionManifest'
import { type LanguageServerSource, LanguageServers } from './languageServers'
import { sandboxSpawnEnv } from './sandbox/spawnEnv'
import { SandboxStore } from './sandbox/store'
import { visibleInSandbox } from './sandbox/visibility'
import { WorkspaceSandboxes } from './sandbox/workspaceSandboxes'
import { onPath } from './systemRequirements'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-lsp.mjs')
const canSandbox =
  process.platform === 'linux' && ['bwrap', 'socat', 'rg'].every((program) => onPath(program))

let root: string
let home: string
let workDir: string
let extensionDir: string
let sandboxes: WorkspaceSandboxes
let servers: LanguageServers
let source: LanguageServerSource
let wraps: { command: string; extraReads: string[] }[]
let messages: Record<string, unknown>[]

function start(builtin: boolean): void {
  wraps = []
  messages = []
  const posted = messages
  const wrapped = wraps
  servers = new LanguageServers({
    sources: () => [{ ...source, builtin }],
    nodePath: process.execPath,
    env: () => process.env,
    pane: () => ({ windowId: 'w1', workspaceId: 'ws' }),
    confine: (path) => path,
    workDir: () => workDir,
    roots: () => [home],
    sandbox: {
      owner: (workspaceId) => (sandboxes.isEnabled(workspaceId) ? workspaceId : null),
      readable: (workspaceId, path) => {
        const { denyRead, allowRead } = sandboxes.config(workspaceId).filesystem
        return visibleInSandbox(path, { denyRead, allowRead: allowRead ?? [] })
      },
      wrap: (workspaceId, command, extraReads) => {
        wrapped.push({ command, extraReads })
        return sandboxes.wrap(workspaceId, command, 'bash', [], extraReads)
      },
      env: (workspaceId, env) => ({
        ...sandboxSpawnEnv(env as Record<string, string>),
        TMPDIR: sandboxes.tmpDir(workspaceId),
      }),
    },
    findProgram: () => null,
    managed: {
      canFetch: () => false,
      executable: () => null,
      folder: () => '',
      fetch: async () => '',
      remove: () => {},
      retain: () => {},
    },
    registerRequirements: () => {},
    post: (_windowId, channel, message) => {
      if (channel.startsWith('lsp:msg:')) posted.push(message as Record<string, unknown>)
    },
    changed: () => {},
  })
}

function lastDiagnostics(): string[] {
  const published = messages.filter((m) => m.method === 'textDocument/publishDiagnostics')
  const params = published.at(-1)?.params as { diagnostics: { message: string }[] } | undefined
  return (params?.diagnostics ?? []).map((d) => d.message)
}

beforeAll(async () => {
  if (!canSandbox) return
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-lsp-sbx-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'secret.txt'), 'top secret\n')
  writeFileSync(join(workDir, 'inside.txt'), 'in the workspace\n')
  extensionDir = installFakeLanguageExtension(join(home, '.config', 'ostia', 'extensions'))
  const manifest = readManifest(extensionDir)
  if (!manifest.ok) throw new Error(manifest.error)
  const [server] = manifest.manifest.contributes.languageServers ?? []
  source = {
    extId: 'fake-lang',
    extName: 'Fake language',
    dir: extensionDir,
    builtin: false,
    state: 'on',
    server,
    settingValues: {},
  }
  const store = new SandboxStore(join(root, 'sandbox.json'))
  store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {} })
  sandboxes = new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({
      home,
      dataDirs: [],
      socketPath: join(root, 'ostia.sock'),
      runtimeReads: [],
    }),
    workDir: () => workDir,
    tmpRoot: join(root, 'tmp'),
    nodePath: process.execPath,
    hostScript,
    onAsk: async () => false,
  })
}, 60_000)

afterAll(() => {
  servers?.stopAll()
  sandboxes?.stopAll()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!canSandbox)(
  'a language server in a sandboxed workspace (Linux only: bwrap)',
  () => {
    it('runs wrapped, reads the workspace and its own extension, and cannot read a file under home', async () => {
      start(false)
      const file = join(workDir, 'notes.txt')
      const [session] = await servers.open('w1', 'p1', file)
      expect(session).toBeDefined()
      expect(wraps).toEqual([
        { command: expect.stringContaining('fake-server.cjs'), extraReads: [extensionDir] },
      ])
      servers.send('w1', session.sessionId, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { processId: null, rootUri: null, capabilities: {} },
      })
      await vi.waitFor(() => expect(messages.some((m) => m.id === 1)).toBe(true), {
        timeout: 20_000,
      })
      servers.send('w1', session.sessionId, { jsonrpc: '2.0', method: 'initialized', params: {} })
      servers.send('w1', session.sessionId, {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: pathToFileURL(file).href,
            languageId: 'fake',
            version: 1,
            text: `READ ${join(home, 'secret.txt')}\nREAD ${join(workDir, 'inside.txt')}\n`,
          },
        },
      })
      await vi.waitFor(() => expect(lastDiagnostics()).toHaveLength(2), { timeout: 20_000 })
      const [secret, inside] = lastDiagnostics()
      expect(secret).toMatch(/^read failed: /)
      expect(inside).toBe('read ok: in the workspace')
      expect(servers.log('fake-lang/fake').entries[0]).toMatchObject({
        kind: 'start',
        sandboxed: true,
      })
      servers.stopAll()
    }, 60_000)

    it('cannot start a user extension’s server without the extra read path', async () => {
      start(true)
      const [session] = await servers.open('w1', 'p1', join(workDir, 'notes.txt'))
      expect(wraps[0].extraReads).toEqual([])
      servers.send('w1', session.sessionId, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { processId: null, rootUri: null, capabilities: {} },
      })
      await vi.waitFor(
        () =>
          expect(servers.log('fake-lang/fake').entries.some((entry) => entry.kind === 'exit')).toBe(
            true,
          ),
        { timeout: 20_000 },
      )
      expect(messages.some((m) => m.id === 1)).toBe(false)
      servers.stopAll()
    }, 60_000)
  },
)
