import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { CommandPalette } from './CommandPalette'

describe('CommandPalette', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState(uiInit, true)
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.restoreAllMocks()
  })

  it('does not mount the palette dialog while paletteOpen is false', () => {
    render(<CommandPalette />)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('lists the visible built-in commands (hidden ones excluded) when open', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)

    expect(await screen.findByRole('combobox')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Split Pane Right/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Toggle Sidebar/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
    expect(screen.queryByText('pane.split')).toBeNull()
  })

  it('filters the list to matching commands as the user types', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    const input = await screen.findByRole('combobox')

    await userEvent.type(input, 'Open')

    expect(await screen.findByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Toggle Sidebar/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Split Pane Right/ })).toBeNull()
  })

  it('runs the selected command via commands.exec and closes the palette', async () => {
    useUIStore.setState({ paletteOpen: true })
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    render(<CommandPalette />)

    await userEvent.click(await screen.findByRole('option', { name: /Open Settings/ }))

    expect(exec).toHaveBeenCalledWith('app.openSettings')
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })

  it('exposes an accessible combobox input and named option rows (a11y)', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)

    const input = await screen.findByRole('combobox')
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('placeholder', 'Search commands, workspaces, tabs… (? for help)')
    expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
  })

  describe('prefixes', () => {
    const seed = () => {
      useWorkspacesStore.setState({
        workspaces: [
          {
            id: 'w1',
            name: 'api',
            customName: 'payments',
            kind: 'terminal',
            workDir: '/src/api',
            state: 'idle',
          },
          { id: 'w2', name: 'web', kind: 'terminal', workDir: '/src/web', state: 'idle' },
        ],
        activeWorkspaceId: 'w2',
      })
      useLayoutStore.setState({
        byWorkspace: {
          w1: {
            root: { type: 'pane', id: 'pane-7', title: '✳ Fix refunds', kind: 'terminal' },
            activePaneId: 'pane-7',
            zoomedPaneId: null,
          },
        },
      })
      useUIStore.setState({ paletteOpen: true })
    }

    it('lists the prefixes when the user types ?', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '?')

      expect(screen.getByRole('option', { name: /^>\s*Commands$/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /^@\s*Workspaces$/ })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: /^#\s*Tabs$/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()
    })

    it('fills in the prefix picked from help', async () => {
      seed()
      render(<CommandPalette />)
      const input = await screen.findByRole('combobox')
      await userEvent.type(input, '?')
      await userEvent.click(screen.getByRole('option', { name: /^@\s*Workspaces$/ }))

      expect(input).toHaveValue('@')
      expect(screen.getByRole('option', { name: /payments/ })).toBeInTheDocument()
    })

    it('switches to a workspace found with @', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '@pay')
      expect(screen.queryByRole('option', { name: /Open Settings/ })).toBeNull()

      await userEvent.click(screen.getByRole('option', { name: /payments/ }))

      expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w1')
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('finds a tab in any workspace with #', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '#refunds')
      expect(screen.getByRole('option', { name: /Fix refunds\s*payments/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /^payments/ })).toBeNull()
    })

    it('shows only commands with >', async () => {
      seed()
      render(<CommandPalette />)
      await userEvent.type(await screen.findByRole('combobox'), '>')
      expect(screen.getByRole('option', { name: /Open Settings/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /payments/ })).toBeNull()
    })
  })

  describe('commands that take an argument', () => {
    afterEach(() => commands.unregister('test.card'))

    const register = (run = vi.fn()) => {
      commands.register<{ argument?: string }, void>({
        id: 'test.card',
        title: 'Test: Open Card',
        argument: 'Card id',
        run,
      })
      return run
    }

    it('asks for the value, then runs the command with it and closes', async () => {
      const run = register()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /Test: Open Card/ }))

      const input = screen.getByPlaceholderText('Card id')
      expect(input).toHaveAttribute('placeholder', 'Card id')
      expect(screen.getByText('Type a value, then press Enter')).toBeInTheDocument()
      expect(run).not.toHaveBeenCalled()
      expect(useUIStore.getState().paletteOpen).toBe(true)

      await userEvent.type(input, ' shop-12 ')
      expect(
        screen.getByText('Press Enter to run Test: Open Card with “shop-12”'),
      ).toBeInTheDocument()
      await userEvent.keyboard('{Enter}')
      expect(run).toHaveBeenCalledWith({ argument: 'shop-12' }, expect.anything())
      expect(useUIStore.getState().paletteOpen).toBe(false)
    })

    it('runs nothing while the value is blank', async () => {
      const run = register()
      useUIStore.setState({ paletteOpen: true })
      render(<CommandPalette />)
      await userEvent.click(await screen.findByRole('option', { name: /Test: Open Card/ }))
      await userEvent.type(screen.getByPlaceholderText('Card id'), '   {Enter}')
      expect(run).not.toHaveBeenCalled()
      expect(useUIStore.getState().paletteOpen).toBe(true)
    })
  })
})
