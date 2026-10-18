import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/tmp' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  shell: {},
}))

import type { PtyAttachResult } from '../../../shared/terminal/ptyApi'
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
