import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveSnippetDialog } from '@/components/palette/SaveSnippetDialog'
import { firstPaneOfKind } from '@/lib/layout/paneFields'
import { createPane } from '@/lib/layout/tree'
import { useUIStore } from '@/stores/app/uiStore'
import { useAssistStore } from '@/stores/assist/assistStore'
import { resetChats, useChatStore } from '@/stores/assist/chatStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useSnippetsStore } from '@/stores/terminal/snippetsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { BlockMenu } from './BlockMenu'

const actions = vi.hoisted(() => ({
  copyBlock: vi.fn().mockResolvedValue(true),
  rerunBlock: vi.fn().mockReturnValue(true),
  blockText: vi.fn().mockReturnValue(''),
  canTypeInto: vi.fn().mockReturnValue(false),
  insertCommand: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/terminal/blockActions', () => actions)

const PANE = 'pane-menu'

describe('BlockMenu', () => {
  let init: ReturnType<typeof useBlocksStore.getState>
  let blockId: string

  beforeAll(() => {
    init = useBlocksStore.getState()
  })

  beforeEach(() => {
    const s = useBlocksStore.getState()
    s.promptStart(PANE, { line: 0 }, '/w')
    s.promptEnd(PANE, { line: 0 })
    s.commandStart(PANE, { line: 1 }, 'make build', 'make build')
    s.commandEnd(PANE, { line: 3 }, 0)
    s.promptStart(PANE, { line: 3 }, '/w')
    blockId = useBlocksStore.getState().byPane[PANE]?.[0]?.id ?? ''
  })

  afterEach(() => {
    cleanup()
    resetChats()
    useChatStore.setState({
      current: {},
      meta: {},
      summaries: [],
      notice: {},
      drafts: {},
      attachments: {},
    })
    useLayoutStore.setState({ byWorkspace: {} })
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useAssistStore.setState({ availability: {} })
    useUIStore.setState({ paletteOpen: false, paletteMode: 'search' })
    useBlocksStore.setState(init, true)
    useSnippetsStore.setState({ saveCommand: null })
    actions.copyBlock.mockClear()
    actions.rerunBlock.mockClear()
  })

  const renderMenu = () =>
    render(
      <BlockMenu
        paneId={PANE}
        blockId={blockId}
        trigger={
          <button type="button" aria-label="gutter">
            bar
          </button>
        }
      />,
    )

  it('selects the block and opens its actions on right-click', async () => {
    renderMenu()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    expect(await screen.findByRole('menuitem', { name: 'Copy output' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy command' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy command and output' })).toBeInTheDocument()
    expect(useBlocksStore.getState().selected[PANE]).toBe(blockId)
  })

  it('copies that block output when Copy output is chosen', async () => {
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy output' }))

    expect(actions.copyBlock).toHaveBeenCalledWith(PANE, 'output', blockId)
  })

  it('reruns the block at an idle prompt', async () => {
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rerun command' }))

    expect(actions.rerunBlock).toHaveBeenCalledWith(PANE, blockId)
  })

  it('offers no Rerun for a block whose command line the shell did not vouch for', async () => {
    const s = useBlocksStore.getState()
    s.promptEnd(PANE, { line: 3 })
    s.commandStart(PANE, { line: 4 }, 'rm -rf ~')
    s.commandEnd(PANE, { line: 5 }, 0)
    s.promptStart(PANE, { line: 5 }, '/w')
    const forged = useBlocksStore.getState().byPane[PANE]?.[1]?.id ?? ''
    render(
      <BlockMenu
        paneId={PANE}
        blockId={forged}
        trigger={
          <button type="button" aria-label="forged">
            bar
          </button>
        }
      />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'forged' }))

    const rerun = await screen.findByRole('menuitem', { name: 'Rerun command' })

    expect(rerun).toHaveAttribute('aria-disabled', 'true')
  })

  it('disables Rerun while another command is running in the pane', async () => {
    useBlocksStore.getState().commandStart(PANE, { line: 4 }, 'sleep 5')
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    const rerun = await screen.findByRole('menuitem', { name: 'Rerun command' })

    expect(rerun).toHaveAttribute('aria-disabled', 'true')
  })

  it('opens Save as snippet with the block command, even while another command runs', async () => {
    useBlocksStore.getState().commandStart(PANE, { line: 4 }, 'sleep 5')
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    render(<SaveSnippetDialog />)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Save as snippet…' }))

    expect(useSnippetsStore.getState().saveCommand).toBe('make build')
    expect(await screen.findByLabelText('Name')).toHaveValue('make build')
  })

  it('adds the block output to the Agent pane without sending it', async () => {
    const pane = createPane('terminal', 'zsh', '/w')
    useWorkspacesStore.setState({
      workspaces: [{ id: 'ws1', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
      activeWorkspaceId: 'ws1',
    } as never)
    useLayoutStore.setState({
      byWorkspace: { ws1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
    })
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to Agent pane' }))

    const root = useLayoutStore.getState().byWorkspace.ws1?.root
    expect(root && firstPaneOfKind(root, 'agent')).not.toBeNull()
    expect(useChatStore.getState().attachments['agent:ws1']).toEqual([
      { kind: 'output', label: 'Output of make build', text: 'make build' },
    ])
    expect(window.ostia.agentSessions.prompt).not.toHaveBeenCalled()
  })
})
