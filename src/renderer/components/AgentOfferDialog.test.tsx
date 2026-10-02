import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { registerTerminal } from '../lib/terminalHandles'
import { useAgentOfferStore } from '../stores/agentOfferStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { AgentOfferDialog } from './AgentOfferDialog'

const OFFER = {
  requestId: 'offer-1',
  extId: 'trellis',
  extName: 'Trellis',
  workspaceId: 'w1',
  label: 'SHOP-7 · Fix the cart',
  text: 'Work on Trellis card SHOP-7 (Fix the cart): read it with `trellis card show SHOP-7`',
}

describe('AgentOfferDialog', () => {
  const stores = [useAgentOfferStore, useBlocksStore, useLayoutStore, useWorkspacesStore] as const
  let inits: unknown[]
  let paste: ReturnType<typeof vi.fn>
  let unregister: () => void

  beforeAll(() => {
    inits = stores.map((store) => store.getState())
  })

  beforeEach(() => {
    paste = vi.fn()
    unregister = registerTerminal('p-claude', { paste } as unknown as Terminal)
    const shell = { ...createPane('terminal'), id: 'p-shell', title: 'zsh' }
    const agent = { ...createPane('terminal'), id: 'p-claude', title: 'claude' }
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w1', name: 'shop', kind: 'terminal', workDir: '~/shop', state: 'idle' } as never,
      ],
      activeWorkspaceId: 'w1',
    })
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: { type: 'tabs', id: 'tabs-1', children: [shell, agent], activeId: shell.id },
          activePaneId: shell.id,
          zoomedPaneId: null,
        },
      } as never,
    })
    useBlocksStore.setState({
      running: { 'p-claude': 'b1' },
      agentBlocks: { 'p-claude': { blockId: 'b1', agent: 'claude' } },
    })
  })

  afterEach(() => {
    cleanup()
    unregister()
    stores.forEach((store, i) => {
      store.setState(inits[i] as never, true)
    })
    vi.mocked(window.pine.extensions.answerAgentOffer).mockClear()
  })

  it('shows nothing until an extension offers text', () => {
    render(<AgentOfferDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists only running agents and pastes the text into the one the human picks, without Enter', async () => {
    const user = userEvent.setup()
    render(<AgentOfferDialog />)
    act(() => useAgentOfferStore.getState().receive(OFFER))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Send to agent: SHOP-7 · Fix the cart')
    expect(dialog).toHaveTextContent('Trellis asks to send this text to an agent')
    expect(screen.getByLabelText('Text to send')).toHaveTextContent(OFFER.text)
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(paste).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(paste).toHaveBeenCalledWith(OFFER.text)
    expect(window.pine.pty.write).not.toHaveBeenCalledWith('p-claude', '\r')
    expect(window.pine.extensions.answerAgentOffer).toHaveBeenCalledWith('offer-1', 'p-claude')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('answers not sent when the human declines', async () => {
    const user = userEvent.setup()
    render(<AgentOfferDialog />)
    act(() => useAgentOfferStore.getState().receive(OFFER))
    await user.click(await screen.findByRole('button', { name: 'Don’t send' }))
    expect(paste).not.toHaveBeenCalled()
    expect(window.pine.extensions.answerAgentOffer).toHaveBeenCalledWith('offer-1', null)
  })

  it('answers not sent and pastes nothing when the agent stopped before the click', async () => {
    const user = userEvent.setup()
    render(<AgentOfferDialog />)
    act(() => useAgentOfferStore.getState().receive(OFFER))
    await screen.findByRole('dialog')
    unregister()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(paste).not.toHaveBeenCalled()
    expect(window.pine.extensions.answerAgentOffer).toHaveBeenCalledWith('offer-1', null)
    expect(window.pine.extensions.answerAgentOffer).not.toHaveBeenCalledWith('offer-1', 'p-claude')
  })

  it('says no agent runs and cannot send when the workspace has none', async () => {
    useBlocksStore.setState({ running: {}, agentBlocks: {} })
    render(<AgentOfferDialog />)
    act(() => useAgentOfferStore.getState().receive(OFFER))
    expect(await screen.findByText('No agent is running in this workspace.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('drops an offer main withdrew', async () => {
    render(<AgentOfferDialog />)
    act(() => useAgentOfferStore.getState().receive(OFFER))
    await screen.findByRole('dialog')
    act(() => useAgentOfferStore.getState().withdraw('offer-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.pine.extensions.answerAgentOffer).not.toHaveBeenCalled()
  })
})
