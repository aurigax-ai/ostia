import '@testing-library/jest-dom/vitest'
import type { PaneActivity } from '@shared/terminal/ptyApi'
import type { QuitAnswer } from '@shared/windows/windowsApi'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LayoutNode } from '@/lib/layout/types'
import {
  confirmQuit,
  quitGroups,
  requestClosePane,
  requestCloseWorkspace,
} from '@/lib/workspaces/closeConfirm'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useCloseConfirmStore } from '@/stores/workspaces/closeConfirmStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { CloseConfirmDialog } from './CloseConfirmDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const pane = (id: string): LayoutNode => ({ type: 'pane', id, title: 'Terminal', kind: 'terminal' })

function seed(runningCommand: string | null): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'alpha', kind: 'terminal', workDir: '/a', state: 'idle' },
      { id: 'w2', name: 'beta', kind: 'terminal', workDir: '/b', state: 'idle' },
    ],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: pane('p1'), activePaneId: 'p1', zoomedPaneId: null },
      w2: { root: pane('p2'), activePaneId: 'p2', zoomedPaneId: null },
    },
  })
  if (runningCommand !== null) {
    useBlocksStore.setState({
      running: { p1: 'b1' },
      byPane: { p1: [{ id: 'b1', paneId: 'p1', command: runningCommand } as CommandBlock] },
    })
  }
}

const workspaceIds = () => useWorkspacesStore.getState().workspaces.map((w) => w.id)

describe('close confirmation', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useCloseConfirmStore.setState({ pending: null })
  })

  it('closes a workspace without asking when nothing is running', async () => {
    seed(null)
    render(<CloseConfirmDialog />)

    await requestCloseWorkspace('w1')

    expect(workspaceIds()).toEqual(['w2'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('names the running command and keeps the workspace on Cancel', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestCloseWorkspace('w1')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('sleep 100')
    expect(dialog).toHaveTextContent('alpha')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing

    expect(workspaceIds()).toEqual(['w1', 'w2'])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks again after a cancelled quit and quits on Quit', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    let quit: Promise<QuitAnswer> = Promise.resolve('quit')
    act(() => {
      quit = confirmQuit(quitGroups())
    })
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(quit).resolves.toBe('cancel')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    act(() => {
      quit = confirmQuit(quitGroups())
    })
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Quit' }))
    await expect(quit).resolves.toBe('quit')
  })

  it('closes the workspace when the dialog is confirmed', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestCloseWorkspace('w1')
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Close workspace' }))
    await closing

    expect(workspaceIds()).toEqual(['w2'])
  })

  it('does not ask when confirmClose is off', async () => {
    seed('sleep 100')
    useSettingsStore.getState().setWorkspaces({ confirmClose: false })
    render(<CloseConfirmDialog />)

    await requestCloseWorkspace('w1')

    expect(workspaceIds()).toEqual(['w2'])
  })

  it('asks before closing the last pane of a workspace that has a running command', async () => {
    seed('npm run dev')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestClosePane('w1', 'p1')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('npm run dev')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()

    const again = requestClosePane('w1', 'p1')
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Close pane' }))
    await again
    expect(useLayoutStore.getState().byWorkspace.w1).toBeUndefined()
  })

  it('asks before closing a tab that has a running command, and not for an idle tab beside it', async () => {
    seed('pnpm dev')
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: {
            type: 'tabs',
            id: 't1',
            activeId: 'p1',
            children: [pane('p1'), pane('p3')],
          } as LayoutNode,
          activePaneId: 'p1',
          zoomedPaneId: null,
        },
      },
    })
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    await requestClosePane('w1', 'p3')
    expect(screen.queryByRole('dialog')).toBeNull()

    const closing = requestClosePane('w1', 'p1')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('pnpm dev')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()
  })

  it('asks before closing an editor tab with unsaved changes', async () => {
    seed(null)
    const editor = {
      type: 'pane',
      id: 'p9',
      title: 'main.rs',
      kind: 'editor',
      filePath: '/a/src/main.rs',
    } as LayoutNode
    useLayoutStore.setState({
      byWorkspace: { w1: { root: editor, activePaneId: 'p9', zoomedPaneId: null } },
    })
    useEditorStatus.getState().setDirty('/a/src/main.rs', true)
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    const closing = requestClosePane('w1', 'p9')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('main.rs has unsaved changes')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await closing
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()
    useEditorStatus.getState().setDirty('/a/src/main.rs', false)
  })

  it('resolves the quit question from the dialog and lists every workspace with commands', async () => {
    seed('sleep 100')
    useBlocksStore.setState((s) => ({
      running: { ...s.running, p2: 'b2' },
      byPane: {
        ...s.byPane,
        p2: [{ id: 'b2', paneId: 'p2', command: 'tail -f log' } as CommandBlock],
      },
    }))
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()

    let quit: Promise<QuitAnswer> = Promise.resolve('quit')
    act(() => {
      quit = confirmQuit(quitGroups())
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('sleep 100')
    expect(dialog).toHaveTextContent('tail -f log')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await expect(quit).resolves.toBe('cancel')
  })

  it('says what the quit loses, counted, above the workspaces', async () => {
    seed('sleep 100')
    useBlocksStore.setState((s) => ({
      running: { ...s.running, p2: 'b2' },
      byPane: { ...s.byPane, p2: [{ id: 'b2', paneId: 'p2', command: 'claude' } as CommandBlock] },
      agentBlocks: { ...s.agentBlocks, p2: { blockId: 'b2', agent: 'claude' } },
    }))
    const groups = quitGroups()
    expect(groups.map((g) => [g.commands, g.agents])).toEqual([
      [['sleep 100'], undefined],
      [[], ['claude']],
    ])
    render(<CloseConfirmDialog />)
    act(() => {
      void confirmQuit([
        ...groups,
        { workspaceId: 'w3', workspace: 'gamma', commands: ['make'], files: ['/c/a', '/c/b'] },
      ])
    })
    const losses = await screen.findByRole('list', {
      name: 'Quitting ends or discards everything listed here.',
    })
    expect(screen.getByRole('dialog')).toHaveTextContent('Quit and lose this work?')
    expect([...losses.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '2 shell processes will be ended',
      '1 agent will be stopped',
      '2 files have unsaved changes',
    ])
    act(() => useCloseConfirmStore.getState().answer(false))
  })

  it('counts the files a quit deletes from scratch folders', async () => {
    render(<CloseConfirmDialog />)
    act(() => {
      void confirmQuit([
        { workspaceId: 'w1', workspace: 'S', commands: ['make'], files: [], scratchFiles: 1 },
      ])
    })
    const losses = await screen.findByRole('list', {
      name: 'Quitting ends or discards everything listed here.',
    })
    expect([...losses.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '1 shell process will be ended',
      '1 file in a scratch folder will be deleted',
    ])
    act(() => useCloseConfirmStore.getState().answer(false))
  })

  it('confirms quit immediately when the setting is off or nothing runs', async () => {
    seed('sleep 100')
    useSettingsStore.getState().setWorkspaces({ confirmQuit: false })
    await expect(confirmQuit(quitGroups())).resolves.toBe('quit')

    useSettingsStore.getState().setWorkspaces({ confirmQuit: true })
    useBlocksStore.setState({ running: {} })
    await expect(confirmQuit(quitGroups())).resolves.toBe('quit')
  })

  it('KSH-C39 leaves a kept shell out of the restart question', async () => {
    seed('sleep 100')
    expect(quitGroups(new Set(['p1']))).toEqual([])
    await expect(confirmQuit(quitGroups(new Set(['p1'])))).resolves.toBe('quit')
  })

  it('KSH-C40 still asks about a running command whose shell is not kept', () => {
    seed('sleep 100')
    expect(quitGroups(new Set()).map((g) => g.commands)).toEqual([['sleep 100']])
    expect(quitGroups(new Set(['p2'])).map((g) => g.commands)).toEqual([['sleep 100']])
  })

  it('KSH-C89 offers to keep the kept shells on Quit, focused, and answers keep-shells', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()
    let quit: Promise<QuitAnswer> = Promise.resolve('cancel')
    act(() => {
      quit = confirmQuit(quitGroups(new Set(['p1'])), ['p1'])
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Quit with kept shells running?')
    expect(dialog).toHaveTextContent('1 kept shell is running')
    expect(dialog).toHaveTextContent('the next start, of any version, reattaches them')
    const keep = screen.getByRole('button', { name: 'Quit and keep shells' })
    await waitFor(() => expect(keep).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()
    await user.click(keep)
    await expect(quit).resolves.toBe('keep-shells')
  })

  it('KSH-C90 ends the kept shells on Quit and end shells', async () => {
    seed('sleep 100')
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()
    let quit: Promise<QuitAnswer> = Promise.resolve('cancel')
    act(() => {
      quit = confirmQuit(quitGroups(new Set(['p1'])), ['p1'])
    })
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Quit and end shells' }))
    await expect(quit).resolves.toBe('quit')
  })

  it('KSH-C91 lists what a quit loses and the kept shells, with a choice for the kept ones', async () => {
    seed('sleep 100')
    useBlocksStore.setState((s) => ({
      running: { ...s.running, p2: 'b2' },
      byPane: { ...s.byPane, p2: [{ id: 'b2', paneId: 'p2', command: 'make' } as CommandBlock] },
    }))
    render(<CloseConfirmDialog />)
    const user = userEvent.setup()
    let quit: Promise<QuitAnswer> = Promise.resolve('quit')
    act(() => {
      quit = confirmQuit(quitGroups(new Set(['p1'])), ['p1'])
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Quit and lose this work?')
    expect(dialog).toHaveTextContent('1 shell process will be ended')
    expect(dialog).toHaveTextContent('make')
    expect(
      screen.getByRole('region', { name: 'Quit with kept shells running?' }),
    ).toHaveTextContent('1 kept shell is running')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect(quit).resolves.toBe('cancel')
  })

  describe('scratch workspaces', () => {
    function seedScratch(files: number): void {
      seed(null)
      useWorkspacesStore.setState((st) => ({
        workspaces: [
          ...st.workspaces,
          {
            id: 'w3',
            name: '1-aaaaaaaaaaaa',
            customName: 'Scratch',
            kind: 'scratch',
            workDir: '/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa',
            state: 'idle',
          },
        ],
      }))
      vi.mocked(window.ostia.scratch.files).mockResolvedValue(files)
    }

    afterEach(() => {
      vi.mocked(window.ostia.scratch.files).mockResolvedValue(0)
      vi.mocked(window.ostia.scratch.reveal).mockClear()
    })

    it('closes an empty scratch workspace without asking', async () => {
      seedScratch(0)
      render(<CloseConfirmDialog />)

      await requestCloseWorkspace('w3')

      expect(workspaceIds()).toEqual(['w1', 'w2'])
      expect(window.ostia.scratch.files).toHaveBeenCalledWith('w3')
    })

    it('asks before deleting the files in its folder, offers Reveal, and deletes on confirm', async () => {
      seedScratch(2)
      useSettingsStore.getState().setWorkspaces({ confirmClose: false })
      render(<CloseConfirmDialog />)
      const user = userEvent.setup()

      const cancelled = requestCloseWorkspace('w3')
      const dialog = await screen.findByRole('dialog')
      expect(dialog).toHaveTextContent('Delete 2 files in the scratch folder?')
      expect(dialog).toHaveTextContent('Scratch')
      await user.click(screen.getByRole('button', { name: 'Reveal' }))
      expect(window.ostia.scratch.reveal).toHaveBeenCalledWith('w3')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await cancelled
      expect(workspaceIds()).toEqual(['w1', 'w2', 'w3'])

      const closing = requestCloseWorkspace('w3')
      await screen.findByRole('dialog')
      await user.click(screen.getByRole('button', { name: 'Delete' }))
      await closing
      expect(workspaceIds()).toEqual(['w1', 'w2'])
    })

    it('reports every scratch workspace to main at quit so main can count its files', () => {
      seedScratch(2)
      useSettingsStore.getState().setWorkspaces({ confirmQuit: false })
      expect(quitGroups()).toEqual([
        { workspaceId: 'w3', workspace: 'Scratch', commands: [], files: [] },
      ])
    })
  })
  describe('a long list', () => {
    const KEPT = 20
    const LONG = `${'make-target-'.repeat(25)}${'x'.repeat(10)}`

    function seedKept(): string[] {
      const ids = Array.from({ length: KEPT }, (_, i) => `k${i + 1}`)
      useWorkspacesStore.setState({
        workspaces: ids.map((id) => ({
          id: `ws-${id}`,
          name: `kept ${id}`,
          kind: 'terminal' as const,
          workDir: '/k',
          state: 'idle' as const,
        })),
        activeWorkspaceId: `ws-${ids[0]}`,
      })
      useLayoutStore.setState({
        byWorkspace: Object.fromEntries(
          ids.map((id) => [`ws-${id}`, { root: pane(id), activePaneId: id, zoomedPaneId: null }]),
        ),
      })
      useBlocksStore.setState({
        running: Object.fromEntries(ids.map((id) => [id, `b-${id}`])),
        byPane: Object.fromEntries(
          ids.map((id) => [id, [{ id: `b-${id}`, paneId: id, command: 'claude' } as CommandBlock]]),
        ),
        agentBlocks: Object.fromEntries(
          ids.map((id) => [id, { blockId: `b-${id}`, agent: 'claude' }]),
        ),
      })
      return ids
    }

    async function openLong() {
      const kept = seedKept()
      render(<CloseConfirmDialog />)
      const groups = Array.from({ length: 12 }, (_, i) => ({
        workspaceId: `g${i + 1}`,
        workspace: i === 0 ? LONG : `group ${i + 1}`,
        commands: [i === 0 ? LONG : `make ${i + 1}`, `sleep ${i + 1}`],
        files: [`/g/${i === 0 ? LONG : `file-${i + 1}`}.md`],
        ...(i === 1 ? { unanswered: true, scratchFiles: 2 } : {}),
      }))
      act(() => {
        void confirmQuit(groups, kept)
      })
      return screen.findByRole('dialog')
    }

    it('keeps losses, workspaces and kept shells in one scroll region above the footer', async () => {
      const dialog = await openLong()
      const body = dialog.querySelector('[data-slot="close-confirm-body"]')
      const footer = dialog.querySelector('[data-slot="dialog-footer"]')
      expect(body).not.toBeNull()
      expect(footer).not.toBeNull()
      expect(body).toHaveClass('overflow-auto', 'min-h-0')
      expect(body).toContainElement(
        screen.getByRole('list', { name: 'Quitting ends or discards everything listed here.' }),
      )
      expect(body).toContainElement(screen.getByRole('list', { name: 'Quit and lose this work?' }))
      const kept = screen.getByRole('region', { name: 'Quit with kept shells running?' })
      expect(body).toContainElement(kept)
      expect(kept.querySelectorAll('li')).toHaveLength(KEPT)
      expect(footer).not.toBeNull()
      expect(body).not.toContainElement(footer as HTMLElement)
      for (const name of ['Cancel', 'Quit and end shells', 'Quit and keep shells']) {
        expect(footer).toContainElement(screen.getByRole('button', { name }))
      }
      expect(dialog.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/)
      expect(screen.getByRole('list', { name: 'Quit and lose this work?' }).className).not.toMatch(
        /overflow/,
      )
      act(() => useCloseConfirmStore.getState().answer(false))
    })

    it('lets unbroken commands, names and files wrap instead of widening the dialog', async () => {
      const dialog = await openLong()
      const command = screen.getAllByText(LONG, { selector: 'span' })[0]
      expect(command).toHaveClass('[overflow-wrap:anywhere]', 'whitespace-normal', 'min-w-0')
      const file = screen.getByText(`${LONG}.md`, { exact: false })
      expect(file).toHaveClass('[overflow-wrap:anywhere]', 'whitespace-normal')
      for (const text of [
        'The window did not answer, so it may have running commands or unsaved files',
        '2 files in the scratch folder',
      ]) {
        expect(screen.getByText(text, { exact: false })).toHaveClass(
          '[overflow-wrap:anywhere]',
          'whitespace-normal',
        )
      }
      const workspace = [...dialog.querySelectorAll('div')].find((el) => el.textContent === LONG)
      expect(workspace).toHaveClass('[overflow-wrap:anywhere]', 'min-w-0')
      act(() => useCloseConfirmStore.getState().answer(false))
    })
  })

  describe('kept shells after a reattach', () => {
    const programs: Record<string, PaneActivity> = {
      k1: { program: 'claude', agentRunning: true },
      k2: { program: 'claude', agentRunning: false },
      k3: { program: 'tail', agentRunning: false },
    }

    function seedReattached(): string[] {
      const ids = ['k1', 'k2', 'k3', 'k4', 'k5']
      useWorkspacesStore.setState({
        workspaces: [{ id: 'w1', name: 'alpha', kind: 'terminal', workDir: '/a', state: 'idle' }],
        activeWorkspaceId: 'w1',
      })
      useLayoutStore.setState({
        byWorkspace: {
          w1: {
            root: {
              type: 'split',
              id: 's1',
              direction: 'horizontal',
              sizes: ids.map(() => 100 / ids.length),
              children: ids.map((id) =>
                id === 'k1' || id === 'k5'
                  ? { ...pane(id), resume: { agent: 'claude' as const, id: `sess-${id}` } }
                  : pane(id),
              ),
            } as LayoutNode,
            activePaneId: 'k1',
            zoomedPaneId: null,
          },
        },
      })
      useBlocksStore.setState({
        running: { k1: 'b-k1', k5: 'b-k5' },
        byPane: {
          k1: [{ id: 'b-k1', paneId: 'k1', command: '' } as CommandBlock],
          k5: [{ id: 'b-k5', paneId: 'k5', command: '' } as CommandBlock],
        },
        agentBlocks: {
          k1: { blockId: 'b-k1', agent: 'claude' },
          k5: { blockId: 'b-k5', agent: 'claude' },
        },
      })
      vi.mocked(window.ostia.pty.activity).mockImplementation(
        async (paneId: string) => programs[paneId] ?? null,
      )
      return ids
    }

    afterEach(() => {
      vi.mocked(window.ostia.pty.activity).mockReset()
      vi.mocked(window.ostia.pty.activity).mockResolvedValue(null)
    })

    async function openKept(): Promise<HTMLElement> {
      const kept = seedReattached()
      render(<CloseConfirmDialog />)
      act(() => {
        void confirmQuit([], kept)
      })
      await screen.findByRole('dialog')
      return screen.getByRole('region', { name: 'Quit with kept shells running?' })
    }

    it('names a reattached agent by its foreground program, or by its known agent', async () => {
      const region = await openKept()
      const rows = [...region.querySelectorAll('li')].map((li) => li.textContent)
      expect(rows.filter((row) => row === 'claude')).toHaveLength(3)
      expect(region).not.toHaveTextContent('A command')
      act(() => useCloseConfirmStore.getState().answer(false))
    })

    it('lists every kept shell still running something, with or without a resume', async () => {
      const region = await openKept()
      expect(region).toHaveTextContent('5 kept shells are running')
      const rows = [...region.querySelectorAll('li')].map((li) => li.textContent)
      expect(rows.sort()).toEqual(['claude', 'claude', 'claude', 'tail'])
      act(() => useCloseConfirmStore.getState().answer(false))
    })
  })
})
