import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPane, firstPaneOfKind } from '../layout/tree'
import { useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import { resetChats, useChatStore } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkflowsStore } from '../stores/workflowsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { BlockMenu } from './BlockMenu'

const actions = vi.hoisted(() => ({
  copyBlock: vi.fn().mockResolvedValue(true),
  rerunBlock: vi.fn().mockReturnValue(true),
  blockText: vi.fn().mockReturnValue(''),
  canTypeInto: vi.fn().mockReturnValue(false),
  insertCommand: vi.fn().mockReturnValue(false),
}))

vi.mock('../lib/blockActions', () => actions)

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
    s.commandStart(PANE, { line: 1 }, 'make build')
    s.commandEnd(PANE, { line: 3 }, 0)
    s.promptStart(PANE, { line: 3 }, '/w')
    blockId = useBlocksStore.getState().byPane[PANE]?.[0]?.id ?? ''
  })

  afterEach(() => {
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
    useWorkflowsStore.setState({ saveCommand: null })
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

  it('disables Rerun while another command is running in the pane', async () => {
    useBlocksStore.getState().commandStart(PANE, { line: 4 }, 'sleep 5')
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    const rerun = await screen.findByRole('menuitem', { name: 'Rerun command' })

    expect(rerun).toHaveAttribute('aria-disabled', 'true')
  })

  it('opens Save as workflow with the block command, even while another command runs', async () => {
    useBlocksStore.getState().commandStart(PANE, { line: 4 }, 'sleep 5')
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Save as workflow…' }))

    expect(useWorkflowsStore.getState().saveCommand).toBe('make build')
  })

  it('opens the chat pane with the block output attached, without sending it', async () => {
    useAssistStore.setState({
      availability: {
        chat: { extId: 'assistant', name: 'Assistant', ref: { extId: 'assistant' } },
      },
    })
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

    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Ask assistant about this output' }),
    )

    const root = useLayoutStore.getState().byWorkspace.ws1?.root
    expect(root && firstPaneOfKind(root, 'chat')).not.toBeNull()
    expect(useChatStore.getState().attachments.ws1).toEqual([
      { kind: 'output', label: 'Output of make build', text: 'make build' },
    ])
    expect(window.pine.assist.request).not.toHaveBeenCalled()
  })

  it('does not offer asking about output while the chat feature is off', async () => {
    useAssistStore.setState({
      availability: {
        chat: { extId: 'assistant', name: 'Assistant', ref: { extId: 'assistant' } },
      },
      overview: [
        {
          extId: 'assistant',
          name: 'Assistant',
          setup: null,
          models: false,
          providers: [],
          kinds: [],
          keysSet: [],
          features: [{ id: 'chat', setting: 'chat', on: false, ready: true }],
        },
      ],
    })
    renderMenu()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

    expect(await screen.findByRole('menuitem', { name: 'Copy output' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Ask assistant about this output' })).toBeNull()
    useAssistStore.setState({ overview: [] })
  })

  describe('Explain error', () => {
    const chat = { extId: 'assistant', name: 'Assistant', ref: { extId: 'assistant' } }

    const failBlock = (): string => {
      const s = useBlocksStore.getState()
      s.commandStart(PANE, { line: 4 }, 'npm test')
      s.commandEnd(PANE, { line: 6 }, 2)
      s.promptStart(PANE, { line: 6 }, '/w')
      return useBlocksStore.getState().byPane[PANE]?.[1]?.id ?? ''
    }

    const openMenu = (id: string) => {
      render(
        <BlockMenu
          paneId={PANE}
          blockId={id}
          trigger={
            <button type="button" aria-label="failed gutter">
              bar
            </button>
          }
        />,
      )
      fireEvent.contextMenu(screen.getByRole('button', { name: 'failed gutter' }))
    }

    it('is not offered for a block that succeeded', async () => {
      useAssistStore.setState({ availability: { chat } })
      renderMenu()
      fireEvent.contextMenu(screen.getByRole('button', { name: 'gutter' }))

      expect(await screen.findByRole('menuitem', { name: 'Copy output' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Explain error' })).toBeNull()
    })

    it('is not offered while the human switched Explain error off', async () => {
      useAssistStore.setState({
        availability: { chat },
        overview: [
          {
            extId: 'assistant',
            name: 'Assistant',
            setup: null,
            models: false,
            providers: [],
            kinds: [],
            keysSet: [],
            features: [{ id: 'explainError', setting: 'explainError', on: false, ready: true }],
          },
        ],
      })
      openMenu(failBlock())

      expect(await screen.findByRole('menuitem', { name: 'Copy output' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Explain error' })).toBeNull()
      useAssistStore.setState({ overview: [] })
    })

    it('is not offered without an assistant that serves chat', async () => {
      openMenu(failBlock())

      expect(await screen.findByRole('menuitem', { name: 'Copy output' })).toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Explain error' })).toBeNull()
    })

    it('opens the chat pane and asks about the failed command with it as context', async () => {
      vi.mocked(window.pine.assist.request).mockReturnValue(new Promise(() => {}))
      useAssistStore.setState({ availability: { chat } })
      const pane = createPane('terminal', 'zsh', '/w')
      useWorkspacesStore.setState({
        workspaces: [{ id: 'ws1', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
        activeWorkspaceId: 'ws1',
      } as never)
      useLayoutStore.setState({
        byWorkspace: { ws1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
      })
      openMenu(failBlock())

      await userEvent.click(await screen.findByRole('menuitem', { name: 'Explain error' }))

      const root = useLayoutStore.getState().byWorkspace.ws1?.root
      expect(root && firstPaneOfKind(root, 'chat')).not.toBeNull()
      await waitFor(() => expect(window.pine.assist.request).toHaveBeenCalled())
      const [point, , input] = vi.mocked(window.pine.assist.request).mock.calls[0]
      expect(point).toBe('chat')
      expect(input).toMatchObject({
        messages: [{ role: 'user', content: 'Explain why this command failed and how to fix it.' }],
        context: [{ kind: 'error', label: 'Failed command' }],
      })
      const context = (input as { context: { text: string }[] }).context[0].text
      expect(context).toContain('npm test')
      expect(context).toContain('[exit 2]')
    })
  })
})
