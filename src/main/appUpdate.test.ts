import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: {},
  Notification: {},
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
}))

const { createUpdateWatcher } = await import('./appUpdate')

const RUNNING = { version: '1.0.0', commit: 'abc', builtAt: '2026-09-30T10:00:00Z' }

describe('createUpdateWatcher', () => {
  it('stays quiet while the installed build is the running one', () => {
    const onUpdate = vi.fn()
    const watcher = createUpdateWatcher({ current: RUNNING, read: () => RUNNING, onUpdate })
    expect(watcher.check()).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('announces a new build once, even at the same version, and again for a later one', () => {
    let disk = { ...RUNNING, commit: 'def', builtAt: '2026-09-30T11:00:00Z' }
    const onUpdate = vi.fn()
    const watcher = createUpdateWatcher({ current: RUNNING, read: () => disk, onUpdate })

    expect(watcher.check()).toEqual(disk)
    expect(watcher.check()).toEqual(disk)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    disk = { ...disk, builtAt: '2026-09-30T12:00:00Z' }
    watcher.check()
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(watcher.available()).toEqual(disk)
  })

  it('ignores a missing or half-written stamp', () => {
    const onUpdate = vi.fn()
    const watcher = createUpdateWatcher({ current: RUNNING, read: () => null, onUpdate })
    expect(watcher.check()).toBeNull()
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
