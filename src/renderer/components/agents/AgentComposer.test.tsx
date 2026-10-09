import { ENTER_AFTER_PASTE_MS } from '@/lib/agents/agentEnter'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { useBlocksStore } from '@/stores/blocksStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentComposer } from './AgentComposer'

function target(paneId: string, title: string): PickTarget {
  return {
    paneId,
    workspaceId: 'w1',
    workspaceName: 'api',
    title,
    state: 'working',
    sameWorkspace: true,
  }
}

const CLAUDE = target('p-claude', 'Claude · refunds')
const CODEX = target('p-codex', 'Codex')

describe('AgentComposer', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let terms: Record<string, { paste: ReturnType<typeof vi.fn> }>
  let unregister: (() => void)[]

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    terms = { 'p-claude': { paste: vi.fn() }, 'p-codex': { paste: vi.fn() } }
    unregister = Object.entries(terms).map(([paneId, term]) =>
      registerTerminal(paneId, term as unknown as Terminal),
    )
    useBlocksStore.setState({
      drafts: {},
      running: { 'p-claude': 'b1', 'p-codex': 'b2' },
      agentBlocks: {
        'p-claude': { blockId: 'b1', agent: 'claude' },
        'p-codex': { blockId: 'b2', agent: 'codex' },
      },
    })
  })

  afterEach(() => {
    for (const off of unregister) off()
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    vi.restoreAllMocks()
  })

  const pressedEnter = (paneId: string) =>
    waitFor(() => expect(window.ostia.pty.write).toHaveBeenCalledWith(paneId, '\r'), {
      timeout: ENTER_AFTER_PASTE_MS + 1000,
    })

  const sendHintClosed = () =>
    waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull())

  it('types the message into the agent and presses Enter when the human clicks Send', async () => {
    const user = userEvent.setup()
    render(<AgentComposer id="w1" targets={[CLAUDE]} onCancel={() => {}} />)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(screen.queryByRole('combobox')).toBeNull()

    await user.type(screen.getByLabelText('Message'), 'rebase onto main first')
    await user.click(send)
    expect(terms['p-claude'].paste).toHaveBeenCalledWith('rebase onto main first')
    await pressedEnter('p-claude')
    expect(screen.getByRole('status')).toHaveTextContent('Sent to Claude · refunds')
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('sends to the agent the human picked when the workspace runs several', async () => {
    const user = userEvent.setup()
    render(<AgentComposer id="w1" targets={[CLAUDE, CODEX]} onCancel={() => {}} />)
    await user.click(screen.getByRole('combobox', { name: 'Agent' }))
    await user.click(await screen.findByRole('option', { name: 'Codex' }))
    await user.type(screen.getByLabelText('Message'), 'stop and report')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(terms['p-codex'].paste).toHaveBeenCalledWith('stop and report')
    expect(terms['p-claude'].paste).not.toHaveBeenCalled()
    await pressedEnter('p-codex')
  })

  it('asks before sending several lines and sends them only after the human confirms', async () => {
    const user = userEvent.setup()
    render(<AgentComposer id="w1" targets={[CLAUDE]} onCancel={() => {}} />)
    await user.type(screen.getByLabelText('Message'), 'first{Enter}second')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(terms['p-claude'].paste).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('first')
    await user.click(screen.getByRole('button', { name: 'Paste' }))
    expect(terms['p-claude'].paste).toHaveBeenCalledWith('first\nsecond')
    await pressedEnter('p-claude')
  })

  it('sends nothing when the human cancels the several-lines question', async () => {
    const user = userEvent.setup()
    render(<AgentComposer id="w1" targets={[CLAUDE]} onCancel={() => {}} />)
    await user.type(screen.getByLabelText('Message'), 'first{Enter}second')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Cancel', hidden: false }))
    expect(terms['p-claude'].paste).not.toHaveBeenCalled()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  it('copies the message instead of typing when the agent stopped running', async () => {
    const user = userEvent.setup()
    render(<AgentComposer id="w1" targets={[CLAUDE]} onCancel={() => {}} />)
    await user.type(screen.getByLabelText('Message'), 'are you there')
    useBlocksStore.setState({ drafts: { 'p-claude': {} as never }, running: {}, agentBlocks: {} })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await sendHintClosed()
    expect(terms['p-claude'].paste).not.toHaveBeenCalled()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    expect(await navigator.clipboard.readText()).toBe('are you there')
    expect(screen.getByRole('status')).toHaveTextContent(/not taking input right now/)
    expect(screen.getByLabelText('Message')).toHaveValue('are you there')
  })

  it('sends with Ctrl+Enter and closes on Cancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<AgentComposer id="w1" targets={[CLAUDE]} onCancel={onCancel} />)
    await user.type(screen.getByLabelText('Message'), 'continue')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(terms['p-claude'].paste).toHaveBeenCalledWith('continue')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
