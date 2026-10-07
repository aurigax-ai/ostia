import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import type { PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useQuestionsStore } from '../stores/questionsStore'
import { useUIStore } from '../stores/uiStore'
import { Pane } from './Pane'

const pane: PaneNode = { type: 'pane', id: 'p9', kind: 'terminal', title: 'zsh' }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Pane', () => {
  it('activates when a portaled surface inside its slot is clicked or focused', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const host = document.createElement('div')
    const { container } = render(
      <>
        <Pane tabs={[pane]} shownId={pane.id} active={false} />
        {createPortal(<textarea aria-label="surface" />, host)}
      </>,
    )
    container.querySelector('.pane-body-term')?.appendChild(host)
    const surface = host.querySelector('textarea') as HTMLTextAreaElement

    surface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'p9' })

    exec.mockClear()
    surface.focus()
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'p9' })
  })

  it('does not re-focus a pane that is already active', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(<Pane tabs={[pane]} shownId={pane.id} active />)
    container.querySelector('.pane')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).not.toHaveBeenCalled()
  })

  it('dims an inactive pane only when the workspace is split', () => {
    const { container, rerender } = render(<Pane tabs={[pane]} shownId={pane.id} active={false} />)
    const frame = container.querySelector('.pane')
    expect(frame).not.toHaveClass('dimmed')
    rerender(<Pane tabs={[pane]} shownId={pane.id} active={false} split />)
    expect(frame).toHaveClass('dimmed')
    rerender(<Pane tabs={[pane]} shownId={pane.id} active split />)
    expect(frame).not.toHaveClass('dimmed')
  })

  it('shows an open question on its pane and opens the dashboard at it', async () => {
    useQuestionsStore.setState({
      pending: [
        {
          id: 'question-4',
          paneId: 'p9',
          question: 'Which database?',
          context: '',
          choices: [],
          mode: 'text',
          at: 1,
        },
      ],
    })
    try {
      render(<Pane tabs={[pane]} shownId={pane.id} active />)
      const notice = screen.getByRole('region', { name: 'Agent asks' })
      expect(notice).toHaveTextContent('Which database?')
      await userEvent.setup().click(within(notice).getByRole('button', { name: 'Answer' }))
      expect(useUIStore.getState().dashboardActive).toBe(true)
      expect(useQuestionsStore.getState().focusId).toBe('question-4')
    } finally {
      act(() => {
        useQuestionsStore.setState({ pending: [], focusId: null })
        useUIStore.setState({ dashboardActive: false })
      })
    }
  })

  it('shows no question notice on a pane that asked nothing', () => {
    render(<Pane tabs={[pane]} shownId={pane.id} active />)
    expect(screen.queryByRole('region', { name: 'Agent asks' })).toBeNull()
  })

  describe('tabs', () => {
    const a: PaneNode = { type: 'pane', id: 'pa', kind: 'terminal', title: 'claude' }
    const b: PaneNode = { type: 'pane', id: 'pb', kind: 'browser', title: 'localhost' }

    it('shows one tab per pane and marks the shown one selected', () => {
      render(<Pane tabs={[a, b]} shownId="pb" active />)
      expect(screen.getByRole('tab', { name: /claude/ })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('tab', { name: /localhost/ })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    it('hides every body but the shown tab’s, keeping them mounted', () => {
      const { container } = render(<Pane tabs={[a, b]} shownId="pb" active />)
      const slots = container.querySelectorAll('.pane-slot')
      expect(slots).toHaveLength(2)
      expect(slots[0]).toHaveAttribute('data-hidden')
      expect((slots[0] as HTMLElement).inert).toBe(true)
      expect(slots[1]).not.toHaveAttribute('data-hidden')
    })

    it('focuses a tab when it is clicked and closes it from its close button', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a, b]} shownId="pb" active />)
      const user = userEvent.setup()

      await user.click(screen.getByRole('tab', { name: /claude/ }))
      expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'pa' })

      await user.click(screen.getAllByRole('button', { name: 'Close tab' })[0])
      expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'pa' })
    })

    it('shows a locked tab with an unlock button in place of its close button', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[{ ...a, locked: true }, b]} shownId="pb" active />)
      const locked = screen.getByRole('tab', { name: /claude/ }).closest('.pane-tab') as HTMLElement

      expect(locked).toHaveClass('locked')
      expect(within(locked).queryByRole('button', { name: 'Close tab' })).toBeNull()
      await userEvent.setup().click(within(locked).getByRole('button', { name: 'Unlock tab' }))
      expect(exec).toHaveBeenCalledWith('pane.toggleLock', { paneId: 'pa' })
    })

    it('closes a tab on middle-click and ignores other auxiliary buttons', () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a, b]} shownId="pb" active />)
      const tab = screen.getByRole('tab', { name: /claude/ }).closest('.pane-tab') as HTMLElement

      fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
      expect(exec).not.toHaveBeenCalledWith('pane.close', { paneId: 'pa' })
      fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'pa' })
    })

    it('opens a new terminal or browser tab next to the shown one', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a]} shownId="pa" active />)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'New terminal tab' }))
      expect(exec).toHaveBeenCalledWith('tab.new', { paneId: 'pa' })
      await user.click(screen.getByRole('button', { name: 'New browser tab' }))
      expect(exec).toHaveBeenCalledWith('tab.newBrowser', { paneId: 'pa' })
    })

    it('shows no new-tab or split buttons on an extension panel or a chat', () => {
      for (const kind of ['extension', 'chat'] as const) {
        const service: PaneNode = { type: 'pane', id: `s-${kind}`, kind, title: kind }
        const view = render(<Pane tabs={[service]} shownId={service.id} active />)
        for (const name of ['New terminal tab', 'New browser tab', 'Split right', 'Split down']) {
          expect(screen.queryByRole('button', { name })).toBeNull()
        }
        view.unmount()
      }
    })

    it('opens a new terminal tab on a double-click in the empty part of the tab strip, not on a tab', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a, b]} shownId="pb" active />)
      const user = userEvent.setup()
      await user.dblClick(screen.getByRole('tab', { name: /claude/ }))
      expect(exec).not.toHaveBeenCalledWith('tab.new', expect.anything())
      await user.dblClick(screen.getByRole('tablist'))
      expect(exec).toHaveBeenCalledWith('tab.new', { paneId: 'pb' })
    })

    it('offers Resume only for a terminal with a saved token at an idle prompt', () => {
      const blocksInit = useBlocksStore.getState()
      const withToken: PaneNode = { ...a, resume: { agent: 'claude', id: 'abc' } }
      const draft = { promptLine: null, inputLine: null } as never
      useBlocksStore.setState({ drafts: { pa: draft }, running: {} })

      const { rerender } = render(<Pane tabs={[withToken]} shownId="pa" active />)
      expect(screen.getByRole('button', { name: /Resume claude/ })).toBeInTheDocument()

      act(() => useBlocksStore.setState({ running: { pa: 'b1' } }))
      expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull()

      act(() => useBlocksStore.setState({ running: {} }))
      rerender(<Pane tabs={[a]} shownId="pa" active />)
      expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull()
      act(() => useBlocksStore.setState(blocksInit, true))
    })
  })
})
