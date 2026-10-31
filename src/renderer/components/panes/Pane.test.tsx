import '@testing-library/jest-dom/vitest'
import type { WorkspaceSandbox } from '@shared/sandbox/sandbox'
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
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { allPanes, tabsOf } from '@/lib/layout/tree'
import type { PaneNode, TabsNode } from '@/lib/layout/types'
import { PANE_DND, startPaneDragTracking } from '@/lib/panes/paneDrag'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { startPaneRenameSync, usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import {
  focusSurfaceWhenReady,
  releaseSurfaces,
  setFocusTarget,
  surfaceHost,
} from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { Pane } from './Pane'
import { PaneTree } from './PaneTree'

const pane: PaneNode = { type: 'pane', id: 'p9', kind: 'terminal', title: 'zsh' }
const SANDBOX_OFF: WorkspaceSandbox = { enabled: false, allowRead: [], domains: [], controls: {} }

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  focusSurfaceWhenReady('', () => false)
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

  it('shows an open question on its pane and answers it there', async () => {
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
      const user = userEvent.setup()
      await user.type(within(notice).getByLabelText('Reply'), 'Postgres')
      await user.click(within(notice).getByRole('button', { name: 'Send' }))
      expect(window.ostia.questions.answer).toHaveBeenCalledWith('question-4', {
        choices: [],
        text: 'Postgres',
      })
    } finally {
      act(() => {
        useQuestionsStore.setState({ pending: [], focusId: null })
      })
    }
  })

  it('shows the phone size line over the pane without moving the terminal, and its close button keeps the hold', async () => {
    const useDesktop = vi.fn()
    usePhoneSizeStore.getState().hold(pane.id, { cols: 44, useDesktop })
    try {
      const { container } = render(
        <Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />,
      )
      expect(container.querySelector('[data-phone-sized]')).toBeInTheDocument()
      expect(container.querySelector('[data-status]')).toBeNull()

      await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))

      const line = container.querySelector('[data-phone-sized]')
      expect(line === null || line.closest('[data-leaving]') !== null).toBe(true)
      expect(usePhoneSizeStore.getState().byPane[pane.id]).toBeDefined()
      expect(useDesktop).not.toHaveBeenCalled()
    } finally {
      act(() => usePhoneSizeStore.setState({ byPane: {} }))
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

  it('SBX-C5 a workspace with the sandbox off spawns an unwrapped shell', async () => {
    const sandbox = useSandboxStore.getState()
    useWorkspacesStore.setState({ activeWorkspaceId: 'w' })
    try {
      useSandboxStore.getState().notePane(pane.id, false)
      vi.mocked(window.ostia.sandbox.get).mockResolvedValue(SANDBOX_OFF)
      await act(async () => {
        render(<Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />)
      })
      expect(useSandboxStore.getState().enabled.w).toBe(false)
      expect(screen.queryByRole('button', { name: 'Restart to apply' })).toBeNull()
    } finally {
      cleanup()
      useSandboxStore.setState(sandbox, true)
    }
  })

  it('SBX-C6 turning the sandbox on asks running panes to restart, and the restart sandboxes them', async () => {
    const sandbox = useSandboxStore.getState()
    useWorkspacesStore.setState({ activeWorkspaceId: 'w' })
    try {
      useSandboxStore.getState().notePane(pane.id, false)
      vi.mocked(window.ostia.sandbox.get).mockResolvedValue(SANDBOX_OFF)
      await act(async () => {
        render(<Pane tabs={[pane]} shownId={pane.id} activePaneId={pane.id} workspaceId="w" />)
      })
      expect(useSandboxStore.getState().enabled.w).toBe(false)
      const on = { ...SANDBOX_OFF, enabled: true }
      vi.mocked(window.ostia.sandbox.setEnabled).mockResolvedValue({ ok: true, settings: on })
      vi.mocked(window.ostia.sandbox.get).mockResolvedValue(on)
      await act(() => useSandboxStore.getState().setEnabled('w', true))
      await userEvent.click(await screen.findByRole('button', { name: 'Restart to apply' }))
      expect(window.ostia.pty.restart).toHaveBeenCalledWith(pane.id)
      expect(screen.queryByRole('button', { name: 'Restart to apply' })).toBeNull()
      act(() => useSandboxStore.getState().notePane(pane.id, true))
      expect(screen.queryByRole('button', { name: 'Restart to apply' })).toBeNull()
    } finally {
      cleanup()
      useSandboxStore.setState(sandbox, true)
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

    it('moves the keyboard into a clicked tab once its surface is ready', async () => {
      vi.spyOn(commands, 'exec').mockImplementation(async () => {
        useLayoutStore.setState({
          byWorkspace: {
            w: { root: tabsOf('pb', a, b), activePaneId: 'pb', zoomedPaneId: null },
          },
        })
        return { ok: true, result: undefined }
      })
      useLayoutStore.setState({
        byWorkspace: { w: { root: tabsOf('pa', a, b), activePaneId: 'pa', zoomedPaneId: null } },
      })
      useWorkspacesStore.setState({ activeWorkspaceId: 'w' })
      render(<Pane tabs={[a, b]} shownId="pa" activePaneId="pa" workspaceId="w" />)
      await userEvent.setup().click(screen.getByRole('tab', { name: /localhost/ }))
      const guest = document.body.appendChild(document.createElement('div'))
      guest.tabIndex = 0
      act(() => {
        setFocusTarget('pb', () => guest)
      })
      expect(document.activeElement).toBe(guest)
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

    it('shows no new-tab or split buttons on a chat', () => {
      for (const kind of ['chat'] as const) {
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

    it('dragging a tab to a terminal pane’s right edge splits it with the tab on the right', async () => {
      const stop = workspace(tabsOf(second.id, first, second))
      try {
        await dragToEdge(second.id, 'right')

        expect(panes()).toEqual([[first.id], [second.id]])
        expect(useLayoutStore.getState().byWorkspace.w.root).toMatchObject({
          type: 'split',
          direction: 'horizontal',
        })
        expect(document.querySelector('.pane-drop-layer')).toBeNull()
      } finally {
        stop()
      }
    })

    it('splitting a pane adds a second terminal', async () => {
      const stop = workspace(tabsOf(first.id, first))
      try {
        await userEvent.setup().click(screen.getByRole('button', { name: 'Split right' }))

        await waitFor(() => expect(document.querySelectorAll('.pane-cell')).toHaveLength(2))
        const panesNow = allPanes(useLayoutStore.getState().byWorkspace.w.root)
        expect(panesNow.map((p) => p.kind)).toEqual(['terminal', 'terminal'])
        expect(panesNow[0].id).toBe(first.id)
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

describe('Pane tab rename', () => {
  const one: PaneNode = { type: 'pane', id: 'r1', kind: 'terminal', title: 'zsh' }
  const two: PaneNode = { type: 'pane', id: 'r2', kind: 'terminal', title: 'claude' }
  const root: TabsNode = { type: 'tabs', id: 'rt', children: [one, two], activeId: 'r1' }

  let stopSync: () => void = () => {}

  function setup(): void {
    if (!commands.has('pane.rename')) registerBuiltinCommands()
    stopSync = startPaneRenameSync()
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
      activeWorkspaceId: 'w',
    })
    useLayoutStore.setState({
      byWorkspace: { w: { root, activePaneId: 'r1', zoomedPaneId: null } },
    })
    render(<PaneTree workspaceId="w" />)
  }

  function titleOf(id: string): PaneNode | undefined {
    const tabs = useLayoutStore.getState().byWorkspace.w?.root as TabsNode
    return tabs.children.find((c): c is PaneNode => c.type === 'pane' && c.id === id)
  }

  afterEach(() => {
    cleanup()
    stopSync()
    usePaneRenameStore.getState().end()
    releaseSurfaces(new Set())
  })

  function nextFrame(): Promise<void> {
    return act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  }

  it('the second click of a double-click does not hand focus back to the terminal', async () => {
    setup()
    const surface = document.createElement('textarea')
    surface.className = 'xterm-helper-textarea'
    const host = surfaceHost('r1')
    host.appendChild(surface)
    if (!host.isConnected) document.body.appendChild(host)
    const user = userEvent.setup()
    await user.dblClick(screen.getByRole('tab', { name: /zsh/ }))
    await nextFrame()
    expect(screen.getByRole('textbox', { name: 'Rename Tab…' })).toHaveFocus()
    expect(titleOf('r1')?.titlePinned).toBeUndefined()
  })

  it('Enter or blur with the name unchanged leaves an automatic title unpinned', async () => {
    setup()
    const user = userEvent.setup()
    await user.dblClick(screen.getByRole('tab', { name: /zsh/ }))
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.dblClick(screen.getByRole('tab', { name: /zsh/ }))
    act(() => screen.getByRole('textbox').blur())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(titleOf('r1')?.titlePinned).toBeUndefined()
  })

  it('closing the tab being renamed ends the edit', async () => {
    setup()
    await userEvent.setup().dblClick(screen.getByRole('tab', { name: /zsh/ }))
    act(() => {
      useLayoutStore.setState({
        byWorkspace: {
          w: {
            root: { ...root, children: [two], activeId: 'r2' },
            activePaneId: 'r2',
            zoomedPaneId: null,
          },
        },
      })
    })
    expect(usePaneRenameStore.getState().paneId).toBeNull()
  })

  it('switching workspace ends the edit', async () => {
    setup()
    await userEvent.setup().dblClick(screen.getByRole('tab', { name: /zsh/ }))
    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'other' }))
    expect(usePaneRenameStore.getState().paneId).toBeNull()
  })

  it('double-clicking a tab title edits it inline; Enter pins the new name', async () => {
    setup()
    const user = userEvent.setup()
    await user.dblClick(screen.getByRole('tab', { name: /zsh/ }))
    const input = screen.getByRole('textbox', { name: 'Rename Tab…' })
    await user.clear(input)
    await user.type(input, 'build{Enter}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(titleOf('r1')).toMatchObject({ title: 'build', titlePinned: true })
  })

  it('Escape cancels and leaves the title alone', async () => {
    setup()
    const user = userEvent.setup()
    await user.dblClick(screen.getByRole('tab', { name: /zsh/ }))
    await user.type(screen.getByRole('textbox'), 'x{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(titleOf('r1')).toMatchObject({ title: 'zsh' })
    expect(titleOf('r1')?.titlePinned).toBeUndefined()
  })

  it('an empty name releases the pinned title', async () => {
    setup()
    act(() => useLayoutStore.getState().rename('w', 'r1', 'pinned'))
    const user = userEvent.setup()
    await user.dblClick(screen.getByRole('tab', { name: /pinned/ }))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Enter}')
    expect(titleOf('r1')?.titlePinned).toBeUndefined()
  })

  it('the Rename Tab item in the tab menu starts the inline edit', async () => {
    setup()
    const user = userEvent.setup()
    fireEvent.contextMenu(screen.getByRole('tab', { name: /claude/ }))
    await user.click(await screen.findByRole('menuitem', { name: /Rename Tab/ }))
    expect(await screen.findByRole('textbox', { name: 'Rename Tab…' })).toHaveValue('claude')
  })

  it('Escape in the menu rename keeps a pinned name', async () => {
    setup()
    act(() => useLayoutStore.getState().rename('w', 'r2', 'builder'))
    const user = userEvent.setup()
    fireEvent.contextMenu(screen.getByRole('tab', { name: /builder/ }))
    await user.click(await screen.findByRole('menuitem', { name: /Rename Tab/ }))
    const input = await screen.findByRole('textbox', { name: 'Rename Tab…' })
    await user.clear(input)
    await user.type(input, 'discarded{Escape}')

    expect(screen.queryByRole('textbox', { name: 'Rename Tab…' })).toBeNull()
    expect(titleOf('r2')).toMatchObject({ title: 'builder', titlePinned: true })
    expect(screen.getByRole('tab', { name: /builder/ })).toBeInTheDocument()
  })

  it('pane.rename without a title starts the inline edit on the active tab', async () => {
    setup()
    await act(async () => {
      await commands.exec('pane.rename')
    })
    expect(screen.getByRole('textbox', { name: 'Rename Tab…' })).toHaveValue('zsh')
  })

  it('pane.rename with a title still renames directly, as the CLI does', async () => {
    setup()
    await act(async () => {
      await commands.exec('pane.rename', { title: 'cli' })
    })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(titleOf('r1')).toMatchObject({ title: 'cli', titlePinned: true })
  })

  it('still opens a new tab on a double-click in the empty strip', async () => {
    setup()
    const exec = vi.spyOn(commands, 'exec')
    await userEvent.setup().dblClick(screen.getByRole('tablist'))
    expect(exec).toHaveBeenCalledWith('tab.new', { paneId: 'r1' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
