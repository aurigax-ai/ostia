import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { tabsOf } from '@/layout/tree'
import type { PaneNode, TabsNode } from '@/layout/types'
import { PANE_DND, startPaneDragTracking } from '@/lib/panes/paneDrag'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createPortal } from 'react-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pane } from './Pane'
import { PaneTree } from './PaneTree'

const pane: PaneNode = { type: 'pane', id: 'p9', kind: 'terminal', title: 'zsh' }

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  useLayoutStore.setState(layoutInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  usePaneDnd.getState().reset()
  vi.restoreAllMocks()
})

describe('Pane', () => {
  it('activates when a portaled surface inside its slot is clicked or focused', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const host = document.createElement('div')
    const { container } = render(
      <>
        <Pane tabs={[pane]} shownId={pane.id} activePaneId="elsewhere" workspaceId="w" />
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
    const { container } = render(
      <Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />,
    )
    container.querySelector('.pane')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).not.toHaveBeenCalled()
  })

  it('dims an inactive pane only when the workspace is split', () => {
    const { container, rerender } = render(
      <Pane tabs={[pane]} shownId={pane.id} activePaneId="elsewhere" workspaceId="w" />,
    )
    const frame = container.querySelector('.pane')
    expect(frame).not.toHaveClass('dimmed')
    rerender(
      <Pane tabs={[pane]} shownId={pane.id} activePaneId="elsewhere" workspaceId="w" split />,
    )
    expect(frame).toHaveClass('dimmed')
    rerender(<Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" split />)
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
      render(<Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />)
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
    render(<Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />)
    expect(screen.queryByRole('region', { name: 'Agent asks' })).toBeNull()
  })

  it('dropping a detached pane onto the main window moves it there and closes the empty window', () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w', name: 'api', kind: 'terminal', workDir: '/home/u/api', state: 'idle' },
      ],
      activeWorkspaceId: 'w',
    })
    const stop = startPaneDragTracking()
    try {
      const { container } = render(
        <Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />,
      )
      const frame = container.querySelector('.pane') as HTMLElement
      vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
      const drag = (type: string, target: Element, at: MouseEventInit = {}): void => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at })
        Object.defineProperty(event, 'dataTransfer', {
          value: { types: [PANE_DND], getData: () => 'pane-x', dropEffect: 'none' },
        })
        fireEvent(target, event)
      }

      drag('dragenter', document.body)
      const layer = container.querySelector('.pane-drop-layer') as HTMLElement
      drag('dragover', layer, { clientX: 790, clientY: 300 })
      expect(container.querySelector('.pane-drop-right')).toBeInTheDocument()
      drag('drop', layer, { clientX: 790, clientY: 300 })

      expect(window.ostia.windows.dropPane).toHaveBeenCalledWith({
        paneId: 'pane-x',
        workspaceId: 'w',
        placement: { paneId: 'p9', zone: 'right' },
      })
    } finally {
      stop()
    }
  })

  describe('tabs', () => {
    const a: PaneNode = { type: 'pane', id: 'pa', kind: 'terminal', title: 'claude' }
    const b: PaneNode = { type: 'pane', id: 'pb', kind: 'browser', title: 'localhost' }

    it('shows one tab per pane and marks the shown one selected', () => {
      render(<Pane tabs={[a, b]} shownId="pb" activePaneId={'pb'} workspaceId="w" />)
      expect(screen.getByRole('tab', { name: /claude/ })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('tab', { name: /localhost/ })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    it('hides every body but the shown tab’s, keeping them mounted', () => {
      const { container } = render(
        <Pane tabs={[a, b]} shownId="pb" activePaneId={'pb'} workspaceId="w" />,
      )
      const slots = container.querySelectorAll('.pane-slot')
      expect(slots).toHaveLength(2)
      expect(slots[0]).toHaveAttribute('data-hidden')
      expect((slots[0] as HTMLElement).inert).toBe(true)
      expect(slots[1]).not.toHaveAttribute('data-hidden')
    })

    it('focuses a tab when it is clicked and closes it from its close button', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a, b]} shownId="pb" activePaneId={'pb'} workspaceId="w" />)
      const user = userEvent.setup()

      await user.click(screen.getByRole('tab', { name: /claude/ }))
      expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'pa' })

      await user.click(screen.getAllByRole('button', { name: 'Close tab' })[0])
      expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'pa' })
    })

    it('shows a locked tab with an unlock button in place of its close button', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(
        <Pane
          tabs={[{ ...a, locked: true }, b]}
          shownId="pb"
          activePaneId={'pb'}
          workspaceId="w"
        />,
      )
      const locked = screen.getByRole('tab', { name: /claude/ }).closest('.pane-tab') as HTMLElement

      expect(locked).toHaveClass('locked')
      expect(within(locked).queryByRole('button', { name: 'Close tab' })).toBeNull()
      await userEvent.setup().click(within(locked).getByRole('button', { name: 'Unlock tab' }))
      expect(exec).toHaveBeenCalledWith('pane.toggleLock', { paneId: 'pa' })
    })

    it('closes a tab on middle-click and ignores other auxiliary buttons', () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a, b]} shownId="pb" activePaneId={'pb'} workspaceId="w" />)
      const tab = screen.getByRole('tab', { name: /claude/ }).closest('.pane-tab') as HTMLElement

      fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
      expect(exec).not.toHaveBeenCalledWith('pane.close', { paneId: 'pa' })
      fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
      expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'pa' })
    })

    it('opens a new terminal or browser tab next to the shown one', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a]} shownId="pa" activePaneId={'pa'} workspaceId="w" />)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'New terminal tab' }))
      expect(exec).toHaveBeenCalledWith('tab.new', { paneId: 'pa' })
      await user.click(screen.getByRole('button', { name: 'New browser tab' }))
      expect(exec).toHaveBeenCalledWith('tab.newBrowser', { paneId: 'pa' })
    })

    it('shows no new-tab or split buttons on an extension panel or a chat', () => {
      for (const kind of ['extension', 'chat'] as const) {
        const service: PaneNode = { type: 'pane', id: `s-${kind}`, kind, title: kind }
        const view = render(
          <Pane tabs={[service]} shownId={service.id} activePaneId={service.id} workspaceId="w" />,
        )
        for (const name of ['New terminal tab', 'New browser tab', 'Split right', 'Split down']) {
          expect(screen.queryByRole('button', { name })).toBeNull()
        }
        view.unmount()
      }
    })

    it('opens a new terminal tab on a double-click in the empty part of the tab strip, not on a tab', async () => {
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      render(<Pane tabs={[a, b]} shownId="pb" activePaneId={'pb'} workspaceId="w" />)
      const user = userEvent.setup()
      await user.dblClick(screen.getByRole('tab', { name: /claude/ }))
      expect(exec).not.toHaveBeenCalledWith('tab.new', expect.anything())
      await user.dblClick(screen.getByRole('tablist'))
      expect(exec).toHaveBeenCalledWith('tab.new', { paneId: 'pb' })
    })

    const first: PaneNode = { type: 'pane', id: 't1', kind: 'terminal', title: 'zsh' }
    const second: PaneNode = { type: 'pane', id: 't2', kind: 'terminal', title: 'zsh' }

    function workspace(root: TabsNode): () => void {
      if (!commands.has('pane.move')) registerBuiltinCommands()
      useWorkspacesStore.setState({
        workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
        activeWorkspaceId: 'w',
      })
      useLayoutStore.setState({
        byWorkspace: { w: { root, activePaneId: root.activeId, zoomedPaneId: null } },
      })
      const stop = startPaneDragTracking()
      render(<PaneTree workspaceId="w" />)
      return stop
    }

    function panes(): string[][] {
      return [...document.querySelectorAll('.pane')].map((p) =>
        [...p.querySelectorAll('.pane-tab')].map((t) => t.getAttribute('data-tab-id') ?? ''),
      )
    }

    function tabEl(id: string): HTMLElement {
      return document.querySelector(`.pane-tab[data-tab-id="${id}"]`) as HTMLElement
    }

    function transfer() {
      const data = new Map<string, string>()
      return {
        get types() {
          return [...data.keys()]
        },
        setData: (type: string, value: string) => data.set(type, value),
        getData: (type: string) => data.get(type) ?? '',
        effectAllowed: '',
        dropEffect: 'none',
      }
    }

    function at(event: Event, clientX: number, clientY: number): Event {
      Object.defineProperty(event, 'clientX', { value: clientX })
      Object.defineProperty(event, 'clientY', { value: clientY })
      return event
    }

    async function drag(id: string, target: () => Element, x: number, y: number): Promise<void> {
      const source = tabEl(id)
      const dataTransfer = transfer()
      fireEvent.dragStart(source, { dataTransfer })
      await waitFor(() => expect(usePaneDnd.getState().sourceId).toBe(id))
      const into = target()
      fireEvent(into, at(createEvent.dragOver(into, { dataTransfer }), x, y))
      fireEvent(into, at(createEvent.drop(into, { dataTransfer }), x, y))
      if (source.isConnected) fireEvent.dragEnd(source, { dataTransfer })
    }

    async function dragToEdge(id: string, edge: 'right' | 'bottom'): Promise<void> {
      const frame = tabEl(id).closest('.pane') as HTMLElement
      vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
      const [x, y] = edge === 'right' ? [800 - 16, 300] : [400, 600 - 16]
      await drag(id, () => frame.querySelector('.pane-drop-layer') as Element, x, y)
    }

    async function dragOntoTab(id: string, targetId: string): Promise<void> {
      vi.spyOn(tabEl(targetId), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 120, 28))
      await drag(id, () => tabEl(targetId), 6, 10)
    }

    it('dragging a tab to a terminal pane’s bottom edge splits it with the tab below', async () => {
      const stop = workspace(tabsOf(second.id, first, second))
      try {
        await dragToEdge(second.id, 'bottom')

        expect(panes()).toEqual([[first.id], [second.id]])
        expect(useLayoutStore.getState().byWorkspace.w.root).toMatchObject({
          type: 'split',
          direction: 'vertical',
        })
        expect(document.querySelector('.pane-drop-layer')).toBeNull()
      } finally {
        stop()
      }
    })

    it('tabs reorder within their tab bar', async () => {
      const stop = workspace(tabsOf(second.id, first, second))
      try {
        await dragOntoTab(second.id, first.id)

        expect(panes()).toEqual([[second.id, first.id]])
        expect(document.querySelector('.pane-drop-layer')).toBeNull()
      } finally {
        stop()
      }
    })

    it('an editor tab dropped on a terminal’s tab bar joins that stack', async () => {
      const editor: PaneNode = {
        type: 'pane',
        id: 'e1',
        kind: 'editor',
        title: 'notes.md',
        filePath: '/w/notes.md',
      }
      const stop = workspace(tabsOf(editor.id, first, editor))
      try {
        await dragToEdge(editor.id, 'right')
        expect(panes()).toEqual([[first.id], [editor.id]])

        await dragOntoTab(editor.id, first.id)
        expect(panes()).toEqual([[editor.id, first.id]])
      } finally {
        stop()
      }
    })
  })
})
