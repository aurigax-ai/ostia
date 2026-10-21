import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { orphanVerdict, planRecovery, RecoveryBook } from '../terminal/ptyReaper'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { isPackaged: false, on: () => {} },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}))

const { registerDiagnostics } = await import('./diagnostics')

interface FakePty {
  owners: number
  killed: boolean
}

const WINDOW = '7'

function contentsOf(calls: string[], destroyed = false): WebContents {
  return {
    id: Number(WINDOW),
    isDestroyed: () => destroyed,
    reload: () => calls.push('reload'),
  } as unknown as WebContents
}

function setup() {
  const calls: string[] = []
  const book = new RecoveryBook()
  const ptys = new Map<string, FakePty>([
    ['shown', { owners: 1, killed: false }],
    ['closed', { owners: 1, killed: false }],
  ])
  const startRecovery = vi.fn((windowId: string, reason: string) => {
    calls.push(`recovery:${reason}`)
    book.start(windowId)
  })
  const finishRecovery = vi.fn((windowId: string, live: Set<string>) => {
    if (!book.end(windowId)) return
    const windowPtys = [...ptys].map(([paneId, pty]) => ({ paneId, owners: pty.owners }))
    for (const paneId of planRecovery(windowPtys, live).reap) {
      const pty = ptys.get(paneId)
      if (pty) pty.killed = true
    }
  })
  const diagnostics = registerDiagnostics({
    log: { file: '', info: () => {}, warn: () => {}, error: () => {} },
    telemetry: { error: () => {} },
    version: '1.0.0',
    logDir: '',
    testHooks: false,
    startRecovery,
    finishRecovery,
    openPath: async () => '',
  })
  const detachAll = () => {
    for (const pty of ptys.values()) pty.owners = 0
  }
  const graceCheck = (paneId: string) => {
    const pty = ptys.get(paneId) as FakePty
    return orphanVerdict({
      current: true,
      owners: pty.owners,
      moving: false,
      held: false,
      recovering: book.isRecovering(WINDOW),
    })
  }
  return { calls, ptys, diagnostics, startRecovery, finishRecovery, detachAll, graceCheck }
}

beforeEach(() => handlers.clear())

describe('reloadWindow', () => {
  it('starts recovery for the window before reloading it', () => {
    const { calls, diagnostics, startRecovery } = setup()
    diagnostics.reloadWindow(contentsOf(calls))
    expect(startRecovery).toHaveBeenCalledWith(WINDOW, 'reload')
    expect(calls).toEqual(['recovery:reload', 'reload'])
  })

  it('does nothing for a destroyed window', () => {
    const { calls, diagnostics, startRecovery } = setup()
    diagnostics.reloadWindow(contentsOf(calls, true))
    expect(startRecovery).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('is what the renderer reload request runs', () => {
    const { calls } = setup()
    handlers.get('diagnostics:reload-window')?.({ sender: contentsOf(calls) })
    expect(calls).toEqual(['recovery:reload', 'reload'])
  })

  it('keeps every pty through a reload and reaps only the panes the window no longer shows', () => {
    const { calls, ptys, diagnostics, detachAll, graceCheck } = setup()
    diagnostics.reloadWindow(contentsOf(calls))
    detachAll()
    expect(graceCheck('shown')).toBe('wait')
    expect(graceCheck('closed')).toBe('wait')
    expect([...ptys.values()].some((pty) => pty.killed)).toBe(false)

    handlers.get('diagnostics:ready')?.({ sender: contentsOf(calls) }, ['shown'])
    expect(ptys.get('shown')?.killed).toBe(false)
    expect(ptys.get('closed')?.killed).toBe(true)
  })

  it('would reap detached ptys after the grace if the reload skipped recovery', () => {
    const { detachAll, graceCheck } = setup()
    detachAll()
    expect(graceCheck('shown')).toBe('reap')
  })
})
