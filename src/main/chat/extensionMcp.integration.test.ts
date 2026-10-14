import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeMcpHttp, startFakeMcpHttp } from '../../../test/fixtures/mcp/startHttpServer'
import type { McpServerSettings } from '../../shared/assist/chatTools'
import { DEFAULT_CAPABILITIES, MANAGER_CAPABILITIES } from '../../shared/capabilities'
import type { ExtensionCaller } from '../../shared/extensions'
import type { CommandResult } from '../../shared/types'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { ExtensionHost, registerExtensionMethods } from '../extensions/extensionHost'
import { ExtensionStore } from '../extensions/extensionStore'
import { registerExtensionMcp } from './extensionMcp'
import { McpHost } from './mcpHost'

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-host-calls')
const FAKE_SERVER = join(__dirname, '../../../test/fixtures/mcp/fake-server.mjs')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }
const SECRET = ['shh', 'not', 'for', 'extensions'].join('-')
const HEADER_SECRET = ['header', 'value', 'kept', 'in', 'main'].join('-')

describe('ext.mcpCall and ext.mcpServers', () => {
  let dir: string
  let host: ExtensionHost
  let mcp: McpHost
  let web: FakeMcpHttp
  let servers: McpServerSettings[] = []

  const call = async (extId: string, method: string, params?: unknown) => {
    const res = await host.invoke(extId, 'call', { method, params }, caller)
    if (!res.ok) return { rpcError: res.message }
    return res.data as Record<string, unknown>
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-mcp-'))
    const socketPath = join(dir, 'control.sock')
    web = await startFakeMcpHttp()
    servers = [
      {
        name: 'fake',
        enabled: true,
        command: [process.execPath, FAKE_SERVER],
        env: {},
        secrets: ['FAKE_TOKEN'],
        disabledTools: ['fail'],
      },
      {
        name: 'web',
        enabled: true,
        url: web.url,
        env: {},
        secrets: ['X-Api-Key'],
        disabledTools: [],
      },
      {
        name: 'quiet',
        enabled: false,
        command: [process.execPath, FAKE_SERVER],
        env: {},
        secrets: [],
        disabledTools: [],
      },
    ]
    const secrets: Record<string, string> = {
      'fake/FAKE_TOKEN': SECRET,
      'web/X-Api-Key': HEADER_SECRET,
    }
    mcp = new McpHost({
      servers: () => servers,
      secret: (server, key) => secrets[`${server}/${key}`] ?? null,
      onStatus: () => {},
      connectTimeoutMs: 10_000,
      callTimeoutMs: 1500,
    })
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => dir,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      readyTimeoutMs: 8000,
      interactiveTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerExtensionMcp({ mcp: () => mcp })
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    mcp.closeAll()
    web.close()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a built-in that asks for mcp holds it only once the human approved it', async () => {
    expect(
      (await call('reacher', 'ext.mcpCall', { server: 'fake', tool: 'echo', input: { text: 'x' } }))
        .rpcError,
    ).toContain('needs-elevation: mcp')
    expect(host.list().find((e) => e.id === 'reacher')?.unapproved).toEqual(['mcp'])
    host.approve('reacher')
    expect(host.list().find((e) => e.id === 'reacher')?.unapproved).toEqual([])
  })

  it('GRF-C123 connects a server that is on but not yet connected, answers with its text, and lists names only', async () => {
    expect(mcp.status().find((s) => s.name === 'fake')?.state).toBe('idle')
    expect(
      await call('reacher', 'ext.mcpCall', {
        server: 'fake',
        tool: 'echo',
        input: { text: 'hello' },
      }),
    ).toEqual({ ok: true, text: 'echo: hello' })
    expect(
      await call('reacher', 'ext.mcpCall', {
        server: 'fake',
        tool: 'echo',
        input: { text: 'typed', structured: true },
      }),
    ).toEqual({ ok: true, text: 'echo: typed', structured: { echoed: 'typed' } })
    const listed = (await call('reacher', 'ext.mcpServers')) as {
      ok: boolean
      servers: { name: string; state: string; tools: string[] }[]
    }
    expect(listed.ok).toBe(true)
    expect(listed.servers.map((s) => s.name)).toEqual(['fake', 'web'])
    expect(listed.servers[0]).toEqual({
      name: 'fake',
      state: 'ready',
      tools: ['echo', 'env', 'slow', 'exit'],
    })
    expect(Object.keys(listed.servers[1] ?? {}).sort()).toEqual(['name', 'state', 'tools'])
  })

  it('GRF-C124 refuses without mcp, passes on the host errors and never hands out a command, header or secret', async () => {
    expect(
      (await call('bare', 'ext.mcpCall', { server: 'fake', tool: 'echo', input: {} })).rpcError,
    ).toContain('needs-elevation: mcp')
    expect((await call('bare', 'ext.mcpServers')).rpcError).toContain('needs-elevation: mcp')
    expect(
      await call('reacher', 'ext.mcpCall', { server: 'quiet', tool: 'echo', input: {} }),
    ).toEqual({ ok: false, error: 'This MCP server is not connected.' })
    expect(
      await call('reacher', 'ext.mcpCall', { server: 'fake', tool: 'fail', input: {} }),
    ).toEqual({ ok: false, error: 'This MCP tool is turned off.' })
    const slow = await call('reacher', 'ext.mcpCall', {
      server: 'fake',
      tool: 'slow',
      input: { ms: 5000 },
    })
    expect(slow).toMatchObject({ ok: false })
    expect(String(slow.error)).toMatch(/time/i)
    const leaked = JSON.stringify([
      await call('reacher', 'ext.mcpServers'),
      await call('reacher', 'ext.mcpCall', { server: 'web', tool: 'echo', input: { text: 'x' } }),
    ])
    for (const word of [SECRET, HEADER_SECRET, FAKE_SERVER, web.url, 'X-Api-Key', 'command'])
      expect(leaked).not.toContain(word)
    expect(DEFAULT_CAPABILITIES).not.toContain('mcp')
    expect(MANAGER_CAPABILITIES).not.toContain('mcp')
  })
})
