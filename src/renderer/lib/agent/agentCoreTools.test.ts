import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentToolRun } from '@/lib/assist/chatToolGate'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { answerApproval, resetChatTools, useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { agentCoreToolDefs } from './agentCoreTools'

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  resetChatTools()
  useSettingsStore.setState(settingsInit, true)
  vi.mocked(window.ostia.agentSessions.coreCall).mockClear()
})

function def(name: string) {
  const found = agentCoreToolDefs().find((d) => d.spec.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

function run(overrides: Partial<AgentToolRun> = {}): AgentToolRun {
  return {
    sessionId: 's1',
    callId: 't7',
    workspaceId: 'w1',
    root: '/work',
    toolCallId: 'tc1',
    signal: new AbortController().signal,
    onApproval: () => undefined,
    onAnswer: () => undefined,
    ...overrides,
  }
}

function setAllow(alwaysAsk: ('ostia_agent_run' | 'ostia_bus_send')[]): void {
  useChatToolsStore.getState().setMode('s1', 'write')
  useSettingsStore.setState({ agent: { ...useSettingsStore.getState().agent, alwaysAsk } })
}

const core = () => vi.mocked(window.ostia.agentSessions.coreCall)

describe('the Agent pane’s ostia tools', () => {
  it('offers the nine tools, and only the two that act are acting tools', () => {
    expect(agentCoreToolDefs().map((d) => d.spec.name)).toEqual([
      'ostia_workspaces',
      'ostia_panes',
      'ostia_managed',
      'ostia_bus_inbox',
      'ostia_pane_read',
      'ostia_pane_wait',
      'ostia_skill',
      'ostia_agent_run',
      'ostia_bus_send',
    ])
  })

  it('runs a read tool through the core call without asking, in Ask mode too', async () => {
    core().mockResolvedValue({ ok: true, output: '[]' })
    const reads = [
      'ostia_workspaces',
      'ostia_panes',
      'ostia_managed',
      'ostia_bus_inbox',
      'ostia_pane_read',
      'ostia_pane_wait',
      'ostia_skill',
    ]
    for (const name of reads) {
      expect(await def(name).run({}, run())).toEqual({ state: 'done', output: '[]' })
    }
    expect(core()).toHaveBeenCalledTimes(reads.length)
    expect(core()).toHaveBeenCalledWith('s1', 't7')
    expect(Object.keys(useChatToolsStore.getState().pending)).toEqual([])
  })

  it('asks before an acting tool in Ask mode and calls only after the human allows it', async () => {
    const outcome = def('ostia_agent_run').run({ agent: 'claude', prompt: 'x' }, run())
    await vi.waitFor(() =>
      expect(useChatToolsStore.getState().pending.tc1).toMatchObject({
        kind: 'ostia',
        grantable: false,
        toolName: 'ostia_agent_run',
      }),
    )
    expect(core()).not.toHaveBeenCalled()
    core().mockResolvedValue({ ok: true, output: '{"paneId":"p"}' })
    answerApproval('tc1', { approved: true, scope: 'once' })
    expect(await outcome).toEqual({ state: 'done', output: '{"paneId":"p"}' })
    expect(core()).toHaveBeenCalledWith('s1', 't7')
  })

  it('never calls the core when the human denies, or when the call is cancelled during the card', async () => {
    const denied = def('ostia_bus_send').run({ to: 'a', text: 'b' }, run())
    await vi.waitFor(() => expect(useChatToolsStore.getState().pending.tc1).toBeDefined())
    answerApproval('tc1', { approved: false })
    expect(await denied).toEqual({ state: 'denied' })

    const abort = new AbortController()
    const cancelled = def('ostia_bus_send').run(
      { to: 'a', text: 'b' },
      run({ toolCallId: 'tc2', signal: abort.signal }),
    )
    await vi.waitFor(() => expect(useChatToolsStore.getState().pending.tc2).toBeDefined())
    abort.abort()
    await cancelled.catch(() => undefined)
    expect(core()).not.toHaveBeenCalled()
  })

  it('runs an acting tool without asking in Allow mode unless the always-ask list names it', async () => {
    core().mockResolvedValue({ ok: true, output: 'sent' })
    setAllow(['ostia_agent_run'])
    expect(await def('ostia_bus_send').run({ to: 'a', text: 'b' }, run())).toEqual({
      state: 'done',
      output: 'sent',
    })
    expect(Object.keys(useChatToolsStore.getState().pending)).toEqual([])

    const listed = def('ostia_agent_run').run(
      { agent: 'claude', prompt: 'x' },
      run({ toolCallId: 'tc3' }),
    )
    await vi.waitFor(() => expect(useChatToolsStore.getState().pending.tc3).toBeDefined())
    expect(core()).toHaveBeenCalledTimes(1)
    answerApproval('tc3', { approved: false })
    await listed
  })

  it('answers the core’s refusal as a tool error the model sees', async () => {
    setAllow([])
    core().mockResolvedValue({ ok: false, error: 'needs-elevation: send-other-pane' })
    expect(await def('ostia_bus_send').run({ to: 'a', text: 'b' }, run())).toEqual({
      state: 'error',
      error: 'needs-elevation: send-other-pane',
    })
  })
})
