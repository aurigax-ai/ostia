import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

const { registerSandboxIpc } = await import('./ipc')
const { SandboxStore } = await import('./store')
const { WorkspaceSandboxes } = await import('./workspaceSandboxes')

const root = mkdtempSync(join(tmpdir(), 'pine-sbx-ipc-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function sender(id: number) {
  return { sender: { id } }
}

describe('sandbox IPC', () => {
  it('SBX-C8 refuses to change the sandbox from a window that does not show the workspace', async () => {
    const store = new SandboxStore(join(root, 'sandbox.json'))
    const sandboxes = new WorkspaceSandboxes({
      store,
      globals: () => DEFAULT_SANDBOX_GLOBALS,
      basePaths: () => ({ home: root, dataDirs: [], socketPath: '', runtimeReads: [] }),
      workDir: () => root,
      tmpRoot: join(root, 'tmp'),
      nodePath: process.execPath,
      hostScript: '',
      onAsk: async () => false,
    })
    registerSandboxIpc({ sandboxes, ownerWindow: (id) => (id === 'ws' ? '1' : undefined) })
    const setEnabled = handlers.get('sandbox:set-enabled')
    const get = handlers.get('sandbox:get')
    expect(await setEnabled?.(sender(2), 'ws', true)).toBeNull()
    expect(await get?.(sender(2), 'ws')).toBeNull()
    expect(store.get('ws').enabled).toBe(false)
    expect(await setEnabled?.(sender(1), 'ws', 'yes')).toBeNull()
    expect(store.get('ws').enabled).toBe(false)
    expect(await setEnabled?.(sender(1), 'ws', true)).toMatchObject({ enabled: true })
    expect(store.get('ws').enabled).toBe(true)
  })
})
