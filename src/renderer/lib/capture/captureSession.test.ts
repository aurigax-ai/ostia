import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PickTarget } from '@/lib/agents/pickTargets'
import {
  type CaptureAdapter,
  type CloseReason,
  closeCapture,
  copyCapture,
  openCapture,
  registerCaptureOpener,
  sendCapture,
  setCaptureStatus,
  showSendMenu,
  triggerCapture,
  useCaptureStore,
} from './captureSession'

const REASONS: CloseReason[] = [
  'escape',
  'outside',
  'scroll',
  'key',
  'guest-focus',
  'copied',
  'sent',
  'cancel',
  'hidden',
  'replaced',
  'source-gone',
]

const target: PickTarget = {
  paneId: 'agent',
  workspaceId: 'w1',
  workspaceName: 'api',
  title: 'Claude Code · api',
  state: 'working',
  sameWorkspace: true,
}

function adapter(over: Partial<CaptureAdapter> = {}): CaptureAdapter {
  return {
    anchor: null,
    takeFocus: true,
    highlight: null,
    copy: vi.fn().mockResolvedValue({ ok: true, status: 'Copied the selection.' }),
    send: vi.fn().mockResolvedValue({ ok: true, inserted: true }),
    clear: vi.fn(),
    ...over,
  }
}

const state = () => useCaptureStore.getState()

afterEach(() => {
  for (const paneId of Object.keys(state().open)) closeCapture(paneId, 'source-gone')
  for (const paneId of Object.keys(state().status)) setCaptureStatus(paneId, null)
  vi.useRealTimers()
})

describe('captureSession', () => {
  it('keeps one open capture per pane and clears the one it replaces', () => {
    const first = adapter()
    const second = adapter()
    const other = adapter()
    openCapture('p1', first)
    openCapture('p2', other)
    openCapture('p1', second)
    expect(first.clear).toHaveBeenCalledExactlyOnceWith('replaced')
    expect(other.clear).not.toHaveBeenCalled()
    expect(Object.keys(state().open).sort()).toEqual(['p1', 'p2'])
    expect(state().open.p1.adapter).toBe(second)
  })

  it.each(REASONS)(
    'on %s it clears the highlight once, drops the capture and its copier',
    (reason) => {
      const held = adapter()
      openCapture('p1', held)
      closeCapture('p1', reason)
      closeCapture('p1', reason)
      expect(held.clear).toHaveBeenCalledExactlyOnceWith(reason)
      expect(state().open.p1).toBeUndefined()
      expect(copyCapture('p1')).toBeNull()
      expect(held.copy).not.toHaveBeenCalled()
    },
  )

  it('copies, shows the status for the pane, closes and clears', async () => {
    const held = adapter()
    openCapture('p1', held)
    await copyCapture('p1')
    expect(held.copy).toHaveBeenCalledTimes(1)
    expect(state().status.p1).toBe('Copied the selection.')
    expect(state().open.p1).toBeUndefined()
    expect(held.clear).toHaveBeenCalledExactlyOnceWith('copied')
  })

  it('drops the status after a while', () => {
    vi.useFakeTimers()
    setCaptureStatus('p1', 'Copied the selection.')
    vi.advanceTimersByTime(5999)
    expect(state().status.p1).toBe('Copied the selection.')
    vi.advanceTimersByTime(1)
    expect(state().status.p1).toBeUndefined()
  })

  it('keeps the capture open with the reason when copying fails or throws', async () => {
    const failing = adapter({
      copy: vi.fn().mockResolvedValue({ ok: false, error: 'Could not copy.' }),
    })
    openCapture('p1', failing)
    await copyCapture('p1')
    expect(state().open.p1.error).toBe('Could not copy.')
    expect(state().open.p1.pending).toBe(false)
    expect(failing.clear).not.toHaveBeenCalled()
    const throwing = adapter({ copy: vi.fn().mockRejectedValue(new Error('Boom.')) })
    openCapture('p2', throwing)
    await copyCapture('p2')
    expect(state().open.p2.error).toBe('Boom.')
  })

  it('sends with the note, shows the status for the pane, closes and clears', async () => {
    const held = adapter()
    openCapture('p1', held)
    await sendCapture('p1', target, 'Check the sum')
    expect(held.send).toHaveBeenCalledWith(target, 'Check the sum')
    expect(state().status.p1).toContain('Claude Code · api')
    expect(state().open.p1).toBeUndefined()
    expect(held.clear).toHaveBeenCalledExactlyOnceWith('sent')
  })

  it('keeps the capture open with the reason when sending fails', async () => {
    const held = adapter({ send: vi.fn().mockResolvedValue({ ok: false, error: 'write-failed' }) })
    openCapture('p1', held)
    await sendCapture('p1', target, '')
    expect(state().open.p1.error).toContain('write-failed')
    expect(held.clear).not.toHaveBeenCalled()
  })

  it('ignores the result of a copy whose capture was closed meanwhile', async () => {
    let finish: (value: { ok: true; status: string }) => void = () => undefined
    const held = adapter({ copy: () => new Promise((resolve) => (finish = resolve)) })
    openCapture('p1', held)
    const copying = copyCapture('p1')
    closeCapture('p1', 'escape')
    finish({ ok: true, status: 'Copied the selection.' })
    await copying
    expect(state().status.p1).toBeUndefined()
    expect(held.clear).toHaveBeenCalledExactlyOnceWith('escape')
  })

  it('starts no second copy while one runs', async () => {
    const held = adapter()
    openCapture('p1', held)
    await Promise.all([copyCapture('p1'), copyCapture('p1')])
    expect(held.copy).toHaveBeenCalledTimes(1)
  })

  it('opens a new capture without the old status', () => {
    setCaptureStatus('p1', 'Copied the selection.')
    openCapture('p1', adapter())
    expect(state().status.p1).toBeUndefined()
  })

  describe('the open chord', () => {
    it('opens the Send menu of an open capture and never captures again', () => {
      const open = vi.fn()
      const unregister = registerCaptureOpener('p1', open)
      openCapture('p1', adapter())
      expect(triggerCapture('p1')).toBe(true)
      expect(open).not.toHaveBeenCalled()
      expect(state().open.p1.sendRequest).toBe(1)
      showSendMenu('p1')
      expect(state().open.p1.sendRequest).toBe(2)
      unregister()
    })

    it('calls the last opener of a pane with no open capture', () => {
      const first = vi.fn()
      const last = vi.fn()
      const stopFirst = registerCaptureOpener('p1', first)
      const stopLast = registerCaptureOpener('p1', last)
      expect(triggerCapture('p1')).toBe(true)
      expect(last).toHaveBeenCalledTimes(1)
      expect(first).not.toHaveBeenCalled()
      stopLast()
      expect(triggerCapture('p1')).toBe(true)
      expect(first).toHaveBeenCalledTimes(1)
      stopFirst()
      expect(triggerCapture('p1')).toBe(false)
    })
  })
})
