import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-workspace-api-'))
process.env.XDG_DATA_HOME = dataHome

const { registerControlServer, stopControlServer } = await import('../control/controlServer')
const { ExtensionHost } = await import('./extensionHost')
const { registerExtensionMethods } = await import('./extensionMethods')
const { ExtensionStore } = await import('./extensionStore')

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-workspace-api')
const userIn = (workspaceId: string): ExtensionCaller => ({
  kind: 'user',
  workspaceId,
  capabilities: [],
})

describe('workspace events and sandbox domains for extensions', () => {
  let dir: string
  let host: InstanceType<typeof ExtensionHost>
  const domains: Record<string, string[]> = {
    sandboxed: ['example.test', 'registry.npmjs.org', 'session.test'],
  }

  const call = async (extId: string, workspaceId: string, method: string, params?: unknown) => {
    const res = await host.invoke(extId, 'call', { method, params }, userIn(workspaceId))
    if (!res.ok) return { rpcError: res.message }
    return res.data as Record<string, unknown>
  }

  const events = async (extId: string) => {
    const res = await host.invoke(extId, 'events', null, userIn('elsewhere'))
    return res.ok ? (res.data as { type: string; payload: unknown }[]) : []
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-workspace-api-host-'))
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => dir,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      isSandboxed: (workspaceId) => workspaceId in domains,
      sandboxDomains: (workspaceId) => domains[workspaceId] ?? null,
      readyTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
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

  afterAll(async () => {
    host?.processes.stopAll()
    await stopControlServer()
    rmSync(dir, { recursive: true, force: true })
    rmSync(dataHome, { recursive: true, force: true })
  })

  it('tells only subscribed extensions that a workspace closed', async () => {
    await events('watcher')
    await events('quiet')
    host.workspaceClosed('w-closing')
    await vi.waitFor(async () =>
      expect(await events('watcher')).toContainEqual({
        type: 'workspace.closed',
        payload: { workspaceId: 'w-closing' },
      }),
    )
    expect(await events('quiet')).toEqual([])
  })

  it('SCX-C19 refuses the sandbox domains of a workspace the extension has no caller in', async () => {
    const res = await call('quiet', 'other', 'ext.sandboxDomains', { workspaceId: 'sandboxed' })
    expect(res).toMatchObject({ ok: false, error: 'not-reached' })
    expect(JSON.stringify(res)).not.toContain('example.test')
  })

  it('answers the allowed domains of a sandboxed workspace the extension has a caller in', async () => {
    const res = await call('watcher', 'sandboxed', 'ext.sandboxDomains', {
      workspaceId: 'sandboxed',
    })
    expect(res).toEqual({
      ok: true,
      domains: ['example.test', 'registry.npmjs.org', 'session.test'],
    })
  })

  it('refuses a workspace that is not sandboxed', async () => {
    const res = await call('watcher', 'plain', 'ext.sandboxDomains', { workspaceId: 'plain' })
    expect(res).toMatchObject({ ok: false, error: 'not-sandboxed' })
  })

  it('forgets the caller when its workspace closes', async () => {
    await call('quiet', 'sandboxed', 'ext.sandboxDomains', { workspaceId: 'sandboxed' })
    host.workspaceClosed('sandboxed')
    const res = await call('quiet', 'other', 'ext.sandboxDomains', { workspaceId: 'sandboxed' })
    expect(res).toMatchObject({ ok: false, error: 'not-reached' })
  })
})
