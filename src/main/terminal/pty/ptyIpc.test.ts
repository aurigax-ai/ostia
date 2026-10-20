import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const listeners = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => listeners.set(channel, fn),
  },
  shell: {},
}))

import type { PtyAttachResult } from '../../../shared/terminal/ptyApi'
import { PaneInput } from '../../panes/paneInput'
import { registerPtyIpc } from './ptyIpc'

const event = { sender: { id: 1 } }
const started: PtyAttachResult = { created: true, buffer: '', cursor: 0, dropped: false }
const refused: PtyAttachResult = { created: false, buffer: 'x', cursor: 0, dropped: false }

describe('pty:attach start errors', () => {
  const errors = new Map<string, string>()
  const ptys = new Map<string, unknown>()
  const attachPty = vi.fn()

  beforeEach(() => {
    handlers.clear()
    errors.clear()
    ptys.clear()
    attachPty.mockReset()
    registerPtyIpc({
      attachPty,
      ptys,
      paneStartErrors: errors,
      keptShells: {},
      agentWork: {},
    } as unknown as Parameters<typeof registerPtyIpc>[0])
  })

  const attach = (paneId: string, opts = {}) =>
    handlers.get('pty:attach')?.(event, paneId, opts) as Promise<PtyAttachResult>

  it('records a thrown attach and a refused spawn, and clears them when the shell starts', async () => {
    attachPty.mockRejectedValueOnce(new Error('spawn exploded'))
    await expect(attach('p1')).rejects.toThrow('spawn exploded')
    expect(errors.get('p1')).toBe('spawn exploded')

    attachPty.mockResolvedValueOnce(refused)
    await attach('p1')
    expect(errors.get('p1')).toBe('the shell did not start')

    attachPty.mockResolvedValueOnce(started)
    await attach('p1')
    expect(errors.has('p1')).toBe(false)
  })

  it('records nothing for an attach-only probe or a pane that already has a pty', async () => {
    attachPty.mockResolvedValue(refused)
    await attach('p2', { attachOnly: true })
    ptys.set('p3', {})
    await attach('p3')
    expect(errors.size).toBe(0)
  })
})

describe('pty:resize', () => {
  const resize = vi.fn()
  const mirror = { resize: vi.fn() }
  const owner = (keepAlive = false) => ({
    keepAlive,
    pty: { cols: 80, rows: 24, resize },
    mirror,
    subs: new Map([['1', {}]]),
  })
  const ptys = new Map<string, unknown>()

  beforeEach(() => {
    listeners.clear()
    ptys.clear()
    resize.mockReset()
    registerPtyIpc({ ptys, keptShells: {}, agentWork: {} } as unknown as Parameters<
      typeof registerPtyIpc
    >[0])
  })

  const send = (sender: number, paneId: string) =>
    listeners.get('pty:resize')?.({ sender: { id: sender } }, paneId, 100, 30)

  it('resizes the pty for a window attached to the pane', () => {
    ptys.set('p1', owner())
    send(1, 'p1')
    expect(resize).toHaveBeenCalledWith(100, 30)
  })

  it('ignores a window that is not attached to the pane, a kept pane and an unknown pane', () => {
    ptys.set('p1', owner())
    ptys.set('p2', owner(true))
    send(2, 'p1')
    send(1, 'p2')
    send(1, 'missing')
    expect(resize).not.toHaveBeenCalled()
  })
})

describe('pty:write', () => {
  const write = vi.fn()
  const canWrite = vi.fn()
  const ptys = new Map<string, unknown>()
  const entry = () => ({ pty: { write }, session: { canWrite }, input: new PaneInput(Date.now) })

  beforeEach(() => {
    listeners.clear()
    ptys.clear()
    write.mockReset()
    canWrite.mockReset().mockReturnValue(true)
    registerPtyIpc({ ptys, keptShells: {}, agentWork: {} } as unknown as Parameters<
      typeof registerPtyIpc
    >[0])
  })

  const send = (paneId: string, data: string, source?: unknown) =>
    listeners.get('pty:write')?.(event, paneId, data, source)

  it('counts a line the renderer tagged as typed', () => {
    const typed = entry()
    ptys.set('p1', typed)
    send('p1', 'fix the cart', 'key')
    send('p1', '\r', 'key')
    expect(write.mock.calls).toEqual([['fix the cart'], ['\r']])
    expect(typed.input.claimHumanPrompt('x')).toBe(true)
  })

  it('does not count untagged text or a source the renderer made up', () => {
    const forged = entry()
    const untagged = entry()
    ptys.set('p1', forged)
    ptys.set('p2', untagged)
    send('p1', 'fix the cart\r', 'ostia')
    send('p2', 'fix the cart\r')
    expect(write).toHaveBeenCalledTimes(2)
    expect(forged.input.claimHumanPrompt('x')).toBe(false)
    expect(untagged.input.claimHumanPrompt('x')).toBe(false)
  })

  it('writes and counts nothing for a window that cannot write', () => {
    const blocked = entry()
    ptys.set('p1', blocked)
    canWrite.mockReturnValue(false)
    send('p1', 'fix the cart\r', 'key')
    expect(write).not.toHaveBeenCalled()
    expect(blocked.input.claimHumanPrompt('x')).toBe(false)
  })
})
