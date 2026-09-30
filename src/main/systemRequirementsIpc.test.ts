import { describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller } from '../shared/extensions'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

const { registerSystemRequirementsIpc } = await import('./systemRequirementsIpc')

describe('system requirements IPC', () => {
  it('SBX-C97 asks the system extension to install exactly the missing packages for the human', async () => {
    const calls: { args: unknown; caller: ExtensionCaller }[] = []
    registerSystemRequirementsIpc({
      ownerWindow: (id) => (id === 'ws' ? '1' : undefined),
      workDir: () => '/work',
      locale: () => 'en',
      systemExtensionEnabled: () => true,
      missing: () => [
        { program: 'bwrap', package: 'bubblewrap' },
        { program: 'socat', package: 'socat' },
      ],
      invokeInstall: async (args, caller) => {
        calls.push({ args, caller })
        return { ok: true }
      },
    })
    const install = handlers.get('system:install-requirements')
    expect(await install?.({ sender: { id: 2 } }, 'sandbox', 'ws')).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
    expect(await install?.({ sender: { id: 1 } }, 'sandbox', 'ws')).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const { args, caller } = calls[0]
    expect((args as { argv: string[] }).argv.slice(0, 2)).toEqual(['bubblewrap', 'socat'])
    expect((args as { argv: string[] }).argv).toContain('--reason')
    expect(caller).toMatchObject({ kind: 'user', workspaceId: 'ws', capabilities: ['shell'] })
  })
})
