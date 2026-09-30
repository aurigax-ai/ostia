import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chordLabel } from '../lib/chords'
import { registerSelectionSender } from '../lib/selectionSenders'
import { commands } from './registry'
import { SEND_SELECTION_COMMAND, registerSelectionSendCommand } from './selectionSend'

describe('selection.sendToAgent command', () => {
  const cleanups: (() => void)[] = []

  beforeAll(() => {
    registerSelectionSendCommand()
  })

  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })

  const ctx = (activePaneId: string | null) => ({ activeWorkspaceId: 's1', activePaneId })

  it('is a palette command whose id is the app chord it answers', () => {
    expect(commands.describe().find((c) => c.id === SEND_SELECTION_COMMAND)).toMatchObject({
      title: 'Send Selection to Agent',
      category: 'Editor',
      hidden: false,
    })
    expect(chordLabel(SEND_SELECTION_COMMAND, false)).toBe('Ctrl+Shift+E')
  })

  it('opens the send panel of the active pane only', async () => {
    const editor = vi.fn()
    const other = vi.fn()
    cleanups.push(registerSelectionSender('p1', editor))
    cleanups.push(registerSelectionSender('p2', other))

    const res = await commands.execWith(ctx('p1'), SEND_SELECTION_COMMAND)

    expect(res).toEqual({ ok: true, result: { opened: true } })
    expect(editor).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
  })

  it('fails when the active pane is not a file view', async () => {
    const res = await commands.execWith(ctx('terminal-pane'), SEND_SELECTION_COMMAND)
    expect(res.ok).toBe(false)
  })

  it('forgets a sender once its view unregisters', async () => {
    const sender = vi.fn()
    const unregister = registerSelectionSender('p1', sender)
    unregister()
    const res = await commands.execWith(ctx('p1'), SEND_SELECTION_COMMAND)
    expect(res.ok).toBe(false)
    expect(sender).not.toHaveBeenCalled()
  })
})
