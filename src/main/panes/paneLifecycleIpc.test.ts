import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (e: { sender: { id: number } }, event: unknown) => void

const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
}))

const { registerPaneLifecycleIpc } = await import('./paneLifecycleIpc')

describe('the lifecycle event of a workspace a window now owns', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('publishes the workspace chips and the Inbox items again, so the new owner window gets both', () => {
    const slots = { publishWorkspaceChips: vi.fn(), publishInbox: vi.fn() }
    const bind = vi.fn()
    registerPaneLifecycleIpc({
      windows: new Map(),
      services: { extensionHost: { slots, remoteFolders: null } },
      scratchFolders: { bind },
    } as never)
    handlers.get('lifecycle:event')?.(
      { sender: { id: 7 } },
      { type: 'workspace-added', workspaceId: 'w1', workDir: '/work' },
    )
    expect(bind).toHaveBeenCalledWith('w1', '/work', '7')
    expect(slots.publishWorkspaceChips).toHaveBeenCalledTimes(1)
    expect(slots.publishInbox).toHaveBeenCalledTimes(1)
  })
})
