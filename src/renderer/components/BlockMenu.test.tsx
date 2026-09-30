import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlocksStore } from '../stores/blocksStore'
import { useWorkflowsStore } from '../stores/workflowsStore'
import { BlockMenu } from './BlockMenu'

const actions = vi.hoisted(() => ({
  copyBlock: vi.fn().mockResolvedValue(true),
  rerunBlock: vi.fn().mockReturnValue(true),
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
})
