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

vi.mock('../../agents/agentWork', () => ({
  backgroundWork: (reported: string | null) => reported,
  readProcessTable: async () => [],
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
    sizeListeners: new Set<(cols: number, rows: number) => void>(),
    hold: null,
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

  it('tells the phones attached to the pane the new size', () => {
    const attached = owner()
    const sizes: Array<[number, number]> = []
    attached.sizeListeners.add((cols, rows) => sizes.push([cols, rows]))
    ptys.set('p1', attached)
    send(1, 'p1')
    expect(sizes).toEqual([[100, 30]])
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

describe('desktop input and a phone size hold', () => {
  const resize = vi.fn()
  const write = vi.fn()
  const sent = vi.fn()
  const ptys = new Map<string, unknown>()
  const held = () => ({
    keepAlive: false,
    pty: { cols: 44, rows: 20, resize, write },
    mirror: { resize: vi.fn() },
    session: { canWrite: () => true },
    input: { note: vi.fn() },
    subs: new Map([['1', { isDestroyed: () => false, send: sent }]]),
    sizeListeners: new Set<(cols: number, rows: number) => void>(),
    hold: { holder: 'gw-1', desktop: { cols: 100, rows: 30 } },
  })

  beforeEach(() => {
    listeners.clear()
    ptys.clear()
    resize.mockReset()
    write.mockReset()
    sent.mockReset()
    registerPtyIpc({ ptys, keptShells: {}, agentWork: {} } as unknown as Parameters<
      typeof registerPtyIpc
    >[0])
  })

  it('gives the desktop size back before a key reaches the program', () => {
    const entry = held()
    ptys.set('p1', entry)
    listeners.get('pty:write')?.({ sender: { id: 1 } }, 'p1', 'a', 'key')
    expect(resize).toHaveBeenCalledWith(100, 30)
    expect(sent).toHaveBeenCalledWith('pty:size:p1', 100, 30, false)
    expect(entry.hold).toBeNull()
    expect(write).toHaveBeenCalledWith('a')
    expect(resize.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0])
  })

  it('keeps the hold for what the terminal answers by itself, such as a cursor report', () => {
    const entry = held()
    ptys.set('p1', entry)
    listeners.get('pty:write')?.({ sender: { id: 1 } }, 'p1', '\x1b[5;1R')
    listeners.get('pty:write')?.({ sender: { id: 1 } }, 'p1', '\x1b[I')
    expect(entry.hold).not.toBeNull()
    expect(resize).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('releases the hold on the release-only signal, without writing, from a window that can write', () => {
    const entry = held()
    ptys.set('p1', entry)
    listeners.get('pty:release-hold')?.({ sender: { id: 1 } }, 'p1')
    expect(entry.hold).toBeNull()
    expect(resize).toHaveBeenCalledWith(100, 30)
    expect(write).not.toHaveBeenCalled()
  })

  it('ignores the release-only signal from a window that cannot write and for an unknown pane', () => {
    const entry = { ...held(), session: { canWrite: () => false } }
    ptys.set('p1', entry)
    listeners.get('pty:release-hold')?.({ sender: { id: 1 } }, 'p1')
    listeners.get('pty:release-hold')?.({ sender: { id: 1 } }, 'missing')
    listeners.get('pty:release-hold')?.({ sender: { id: 1 } }, 7)
    expect(entry.hold).not.toBeNull()
  })

  it('ends the hold on a desktop resize and applies the size the desktop asked for', () => {
    const entry = held()
    ptys.set('p1', entry)
    listeners.get('pty:resize')?.({ sender: { id: 1 } }, 'p1', 90, 25)
    expect(resize).toHaveBeenCalledWith(90, 25)
    expect(sent).toHaveBeenCalledWith('pty:size:p1', 90, 25, false)
    expect(entry.hold).toBeNull()
  })

  it('leaves the hold alone when a window that cannot write sends a key', () => {
    const entry = { ...held(), session: { canWrite: () => false } }
    ptys.set('p1', entry)
    listeners.get('pty:write')?.({ sender: { id: 1 } }, 'p1', 'a')
    expect(entry.hold).not.toBeNull()
    expect(write).not.toHaveBeenCalled()
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
    expect(typed.input.claimHumanPrompt('x')).not.toBeNull()
  })

  it('does not count untagged text or a source the renderer made up', () => {
    const forged = entry()
    const untagged = entry()
    ptys.set('p1', forged)
    ptys.set('p2', untagged)
    send('p1', 'fix the cart\r', 'ostia')
    send('p2', 'fix the cart\r')
    expect(write).toHaveBeenCalledTimes(2)
    expect(forged.input.claimHumanPrompt('x')).toBeNull()
    expect(untagged.input.claimHumanPrompt('x')).toBeNull()
  })

  it('writes and counts nothing for a window that cannot write', () => {
    const blocked = entry()
    ptys.set('p1', blocked)
    canWrite.mockReturnValue(false)
    send('p1', 'fix the cart\r', 'key')
    expect(write).not.toHaveBeenCalled()
    expect(blocked.input.claimHumanPrompt('x')).toBeNull()
  })
})

describe('pty:hibernate', () => {
  const ptys = new Map<string, unknown>()
  const hibernatePty = vi.fn(() => true)
  let reported: string | null
  let held: (paneId: string, writes: number) => boolean

  beforeEach(() => {
    handlers.clear()
    ptys.clear()
    hibernatePty.mockClear()
    reported = null
    held = () => false
    registerPtyIpc({
      ptys,
      hibernatePty,
      hibernateHeld: (paneId: string, writes: number) => held(paneId, writes),
      agentWork: { reason: () => reported },
      keptShells: {},
    } as unknown as Parameters<typeof registerPtyIpc>[0])
  })

  const hibernate = (paneId: string) => handlers.get('pty:hibernate')?.(event, paneId)

  it('stops an idle pane and refuses one with reported work', async () => {
    ptys.set('p1', { pty: { pid: 1 }, input: new PaneInput(Date.now) })
    reported = 'subagent'
    expect(await hibernate('p1')).toBe('subagent')
    reported = null
    expect(await hibernate('p1')).toBe('hibernated')
    expect(hibernatePty).toHaveBeenCalledTimes(1)
  })

  it('CLA-M4 answers typed and stops nothing when input reached the pane during an account move', async () => {
    const input = new PaneInput(Date.now)
    ptys.set('p1', { pty: { pid: 1 }, input })
    held = (paneId, writes) => paneId === 'p1' && writes > 0
    input.note('x', 'key')
    expect(await hibernate('p1')).toBe('typed')
    expect(hibernatePty).not.toHaveBeenCalled()
  })
})
