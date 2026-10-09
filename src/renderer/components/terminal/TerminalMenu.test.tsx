import * as clearTerminal from '@/lib/terminal/clearTerminal'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalMenu } from './TerminalMenu'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useBlocksStore.setState({ running: {} })
})

function setup(selection: string) {
  const term = {
    hasSelection: vi.fn(() => selection.length > 0),
    getSelection: vi.fn(() => selection),
    selectAll: vi.fn(),
    focus: vi.fn(),
  }
  const onPaste = vi.fn()
  render(
    <TerminalMenu
      paneId="p1"
      termRef={{ current: term as unknown as Xterm }}
      onPaste={onPaste}
      trigger={<div data-testid="host" />}
    />,
  )
  fireEvent.contextMenu(screen.getByTestId('host'))
  return { term, onPaste }
}

describe('TerminalMenu', () => {
  it('copies the selection, and offers Copy only when there is one', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    setup('npm test')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy' }))
    expect(write).toHaveBeenCalledWith('npm test')
  })

  it('disables Copy without a selection, and pastes and selects all', async () => {
    const { term, onPaste } = setup('')
    const copy = await screen.findByRole('menuitem', { name: 'Copy' })
    expect(copy).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Paste' }))
    expect(onPaste).toHaveBeenCalled()
    fireEvent.contextMenu(screen.getByTestId('host'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Select All' }))
    expect(term.selectAll).toHaveBeenCalled()
  })

  it('clears the terminal and redraws the prompt only when the shell is idle', async () => {
    const clear = vi.spyOn(clearTerminal, 'clearKeepingScrollback').mockResolvedValue(true)
    const { term } = setup('')
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear Terminal' }))
    expect(clear).toHaveBeenCalledWith(term, true)
    useBlocksStore.setState({ running: { p1: 'b1' } })
    fireEvent.contextMenu(screen.getByTestId('host'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear Terminal' }))
    expect(clear).toHaveBeenLastCalledWith(term, false)
  })
})
