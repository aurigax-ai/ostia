import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it, vi } from 'vitest'

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
    expect((args as { argv: string[] }).argv.at(-1)).toBe('--wait')
    expect(caller).toMatchObject({ kind: 'user', workspaceId: 'ws', capabilities: ['shell'] })
  })

  it('tells the human which feature needs the packages by its registered name', async () => {
    const reasons: string[] = []
    registerSystemRequirementsIpc({
      ownerWindow: () => '1',
      workDir: () => undefined,
      locale: () => 'en',
      systemExtensionEnabled: () => true,
      missing: () => [{ program: 'gopls', package: 'gopls' }],
      label: (feature) => (feature === 'lsp:lsp-gopls/gopls' ? 'gopls' : feature),
      invokeInstall: async (args) => {
        reasons.push(args.argv[args.argv.indexOf('--reason') + 1])
        return { ok: true }
      },
    })
    const install = handlers.get('system:install-requirements')
    await install?.({ sender: { id: 1 } }, 'lsp:lsp-gopls/gopls', 'ws')
    expect(reasons).toEqual([expect.stringContaining('gopls feature')])
    expect(reasons[0]).not.toContain('lsp:')
  })

  it('KSH-C90 answers the Settings requirement check only after the login shell PATH is known', async () => {
    let found = false
    let finish: () => void = () => {}
    registerSystemRequirementsIpc({
      ownerWindow: () => undefined,
      workDir: () => undefined,
      locale: () => 'en',
      systemExtensionEnabled: () => true,
      missing: () => (found ? [] : [{ program: 'tmux', package: 'tmux' }]),
      settled: () =>
        new Promise<void>((done) => {
          finish = done
        }),
      invokeInstall: async () => ({ ok: true }),
    })
    const answer = handlers.get('system:requirements')?.({}, 'keep-shells') as Promise<unknown>
    found = true
    finish()
    expect(await answer).toMatchObject({ missing: [], canInstall: false })
  })
})
