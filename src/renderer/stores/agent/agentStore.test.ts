import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/assist/chatTools', () => ({
  workspaceFolder: () => '/work',
  chatToolDefs: () => [],
}))

import { modeFor, useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { ensureAgentSession, setAgentRules, useAgentStore } from './agentStore'

describe('the Agent session and its rules chip', () => {
  let open: ReturnType<typeof vi.mocked<typeof window.ostia.agentSessions.open>>

  beforeEach(() => {
    open = vi.mocked(window.ostia.agentSessions.open)
    open.mockReset()
    open.mockResolvedValue({ ok: true, rules: 3 })
  })

  it('opens a session with the rules on and remembers how many went in', async () => {
    await ensureAgentSession('w1', 'p1', 'a-open')
    expect(open).toHaveBeenCalledWith(
      'a-open',
      expect.objectContaining({ rules: true, paneId: 'p1' }),
    )
    expect(useAgentStore.getState().rules['a-open']).toEqual({ on: true, count: 3 })
  })

  it('opens the session again without the rules when the human turns the chip off, and with them when back on', async () => {
    await ensureAgentSession('w1', 'p1', 'a-toggle')
    open.mockResolvedValue({ ok: true, rules: 0 })
    await setAgentRules('a-toggle', false)
    expect(open).toHaveBeenLastCalledWith('a-toggle', expect.objectContaining({ rules: false }))
    expect(useAgentStore.getState().rules['a-toggle']).toEqual({ on: false, count: 0 })
    open.mockResolvedValue({ ok: true, rules: 3 })
    await setAgentRules('a-toggle', true)
    expect(open).toHaveBeenLastCalledWith('a-toggle', expect.objectContaining({ rules: true }))
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('does not open again when the chip is set to what it already is', async () => {
    await ensureAgentSession('w1', 'p1', 'a-same')
    await setAgentRules('a-same', true)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('gives the session the tools that reach other panes, and the pane it belongs to', async () => {
    await ensureAgentSession('w1', 'p7', 'a-tools')
    const options = open.mock.calls[0][1]
    expect(options.paneId).toBe('p7')
    expect(options.tools.map((t) => t.name)).toEqual([
      'ostia_workspaces',
      'ostia_panes',
      'ostia_managed',
      'ostia_bus_inbox',
      'ostia_pane_read',
      'ostia_pane_wait',
      'ostia_agent_run',
      'ostia_bus_send',
    ])
  })

  it('opens the session again with the new workspace when the pane moves to another workspace', async () => {
    await ensureAgentSession('w1', 'p1', 'a-ws-moved')
    await ensureAgentSession('w2', 'p1', 'a-ws-moved')
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenLastCalledWith(
      'a-ws-moved',
      expect.objectContaining({ workspaceId: 'w2', paneId: 'p1' }),
    )
  })

  it('opens the session again when the pane that holds it changes', async () => {
    await ensureAgentSession('w1', 'p1', 'a-moved')
    await ensureAgentSession('w1', 'p2', 'a-moved')
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenLastCalledWith('a-moved', expect.objectContaining({ paneId: 'p2' }))
  })

  it('starts an Agent pane session in Ask mode and keeps a mode the human chose', async () => {
    await ensureAgentSession('w1', 'p1', 'a-mode')
    expect(modeFor('a-mode')).toBe('ask')
    useChatToolsStore.getState().setMode('a-mode', 'write')
    await ensureAgentSession('w1', 'p1', 'a-mode')
    expect(modeFor('a-mode')).toBe('write')
  })
})
