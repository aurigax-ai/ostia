import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { CommandPalette } from '@/components/palette/CommandPalette'
import { useUIStore } from '@/stores/app/uiStore'
import { startRailEditSync, useRailEditStore } from '@/stores/workspaces/railEditStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { renderSettled } from '../../../../test/render'
import { DeckRail } from './DeckRail'

const PALETTE_COMMANDS = new Set(['workspace.rename', 'workspace.describe'])

describe('DeckRail edits started from the palette', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let stopSync: () => void = () => {}
  let terminal: HTMLTextAreaElement

  beforeAll(() => {
    if (!commands.has('workspace.rename')) registerBuiltinCommands()
    for (const { id } of commands.list()) {
      if (!PALETTE_COMMANDS.has(id)) commands.unregister(id)
    }
    workspacesInit = useWorkspacesStore.getState()
    uiInit = useUIStore.getState()
  })

  beforeEach(() => {
    stopSync = startRailEditSync()
    useWorkspacesStore.setState({
      workspaces: [{ id: 's1', name: 'solo', kind: 'terminal', workDir: '/solo', state: 'idle' }],
      activeWorkspaceId: 's1',
    })
    terminal = document.createElement('textarea')
    terminal.className = 'xterm-helper-textarea'
    document.body.appendChild(terminal)
  })

  afterEach(() => {
    cleanup()
    terminal.remove()
    stopSync()
    useRailEditStore.setState({ editing: null, recollapse: false })
    useWorkspacesStore.setState(workspacesInit, true)
    useUIStore.setState(uiInit, true)
  })

  async function runFromPalette(title: string, id: string): Promise<void> {
    act(() => useUIStore.getState().togglePalette())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('combobox'))
    await user.paste(title)
    const option = screen
      .getAllByRole('option')
      .find((o) => o.querySelector('[data-slot="palette-meta"]')?.textContent === id)
    if (!option) throw new Error(`no palette row for ${id}`)
    await user.click(option)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  async function typeIntoEditor(label: string, text: string): Promise<void> {
    const input = screen.getByRole('textbox', { name: label })
    await waitFor(() => expect(input).toHaveFocus())
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(input).toHaveFocus()
    const user = userEvent.setup()
    await user.clear(input)
    await user.type(input, `${text}{Enter}`)
    expect(screen.queryByRole('textbox', { name: label })).toBeNull()
  }

  it('Rename Workspace from the palette focuses the rail editor and keeps the typed name', async () => {
    await renderSettled(
      <>
        <DeckRail />
        <CommandPalette />
      </>,
    )
    act(() => terminal.focus())

    await runFromPalette('Rename Workspace', 'workspace.rename')
    await typeIntoEditor('Workspace name', 'renamed-from-palette')
    expect(useWorkspacesStore.getState().workspaces[0].customName).toBe('renamed-from-palette')
    expect(screen.getByRole('button', { name: /renamed-from-palette/ })).toBeInTheDocument()

    act(() => terminal.focus())
    await runFromPalette('Describe Workspace', 'workspace.describe')
    await typeIntoEditor('Workspace description', 'notes from palette')
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      customName: 'renamed-from-palette',
      description: 'notes from palette',
    })
  })
})
