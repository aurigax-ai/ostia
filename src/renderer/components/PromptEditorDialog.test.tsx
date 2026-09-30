import type { ExtensionInfo } from '@shared/extensions'
import type { PromptContext } from '@shared/types'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '../layout/types'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { PromptEditorDialog, activeTerminalPaneId } from './PromptEditorDialog'

const PANE = 'p1'

const extension = (patch: Partial<ExtensionInfo>): ExtensionInfo => ({
  id: 'git',
  name: 'Git',
  version: '1.0.0',
  description: '',
  builtin: true,
  enabled: true,
  status: 'running',
  requested: [],
  granted: [],
  unapproved: [],
  commands: [],
  panel: null,
  paneChips: [],
  settings: [],
  settingValues: {},
  assist: [],
  secrets: [],
  secretsSet: [],
  ...patch,
})

const CONTEXT: PromptContext = {
  user: 'ada',
  host: 'box',
  home: '/home/u',
  virtualEnv: null,
  condaEnv: null,
  nodeVersion: null,
  kubeContext: null,
}

const pane = (id: string, kind: PaneNode['kind'] = 'terminal'): PaneNode => ({
  type: 'pane',
  id,
  title: id,
  kind,
  cwd: '/home/u/proj',
})

function seed(kind: PaneNode['kind'] = 'terminal'): void {
  useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
  useLayoutStore.setState({
    byWorkspace: { w1: { root: pane(PANE, kind), activePaneId: PANE, zoomedPaneId: null } },
  })
}

function setChips(chips: string[]): void {
  useSettingsStore.setState((s) => ({
    terminal: { ...s.terminal, prompt: { ...s.terminal.prompt, chips } },
  }))
}

const selected = () => screen.getByRole('list', { name: 'In the prompt' })
const selectedIds = () =>
  within(selected())
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-chip'))

describe('PromptEditorDialog', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let chipsInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    chipsInit = useExtensionsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.pine.pty.promptContext).mockResolvedValue(CONTEXT)
  })

  afterEach(() => {
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useExtensionsStore.setState(chipsInit, true)
    vi.mocked(window.pine.pty.promptContext).mockReset()
  })

  it('finds the active terminal pane and nothing for another surface', () => {
    seed()
    expect(activeTerminalPaneId()).toBe(PANE)
    seed('browser')
    expect(activeTerminalPaneId()).toBeNull()
  })

  it('previews the active pane’s real values and marks chips without one', async () => {
    seed()
    setChips(['user', 'kube', 'cwd'])
    useUIStore.getState().openPromptEditor(PANE)
    render(<PromptEditorDialog />)
    const preview = screen.getByRole('region', { name: 'Preview' })
    expect(await within(preview).findByText('ada')).toBeVisible()
    expect(within(preview).getByText('~/proj')).toBeVisible()
    expect(within(preview).getByLabelText('Kubernetes context: no value here')).toHaveAttribute(
      'data-unavailable',
    )
  })

  it('shows no preview values without a terminal', () => {
    useUIStore.getState().openPromptEditor(null)
    render(<PromptEditorDialog />)
    expect(screen.getByText('Open a terminal to preview its values.')).toBeVisible()
    expect(window.pine.pty.promptContext).not.toHaveBeenCalled()
  })

  it('adds, removes and reorders chips with buttons and Alt+arrow keys', async () => {
    seed()
    setChips(['cwd', 'user'])
    useUIStore.getState().openPromptEditor(PANE)
    render(<PromptEditorDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Add Time (24-hour)' }))
    expect(selectedIds()).toEqual(['cwd', 'user', 'time24'])
    await userEvent.click(screen.getByRole('button', { name: 'Move Time (24-hour) up' }))
    expect(selectedIds()).toEqual(['cwd', 'time24', 'user'])
    const handle = screen.getByRole('button', { name: 'Reorder Working directory' })
    handle.focus()
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(selectedIds()).toEqual(['time24', 'cwd', 'user'])
    expect(screen.getByRole('button', { name: 'Reorder Working directory' })).toHaveFocus()
    expect(screen.getByText('Working directory moved to position 2')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove User' }))
    expect(selectedIds()).toEqual(['time24', 'cwd'])
    expect(screen.getByRole('button', { name: 'Add User' })).toBeVisible()
  })

  it('lists the pane chips of enabled extensions as available', () => {
    useExtensionsStore.setState({
      list: [
        extension({ id: 'ports', paneChips: [{ id: 'port', title: 'Listening port' }] }),
        extension({ id: 'off', enabled: false, paneChips: [{ id: 'x', title: 'Hidden chip' }] }),
      ],
    })
    useUIStore.getState().openPromptEditor(null)
    render(<PromptEditorDialog />)
    expect(screen.getByRole('button', { name: 'Add Listening port (extension)' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add Hidden chip (extension)' })).toBeNull()
  })

  it("places the git extension's branch and diff stats chips after the directory by default", () => {
    useExtensionsStore.setState({
      list: [
        extension({
          id: 'git',
          paneChips: [
            { id: 'branch', title: 'Git branch' },
            { id: 'diff-stats', title: 'Git diff stats' },
          ],
        }),
      ],
    })
    useUIStore.getState().openPromptEditor(null)
    render(<PromptEditorDialog />)
    expect(screen.getByRole('button', { name: 'Remove Git branch (extension)' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Remove Git diff stats (extension)' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add Git branch (extension)' })).toBeNull()
  })

  it('saves the order, same line and separator and switches to the Pine prompt', async () => {
    setChips(['cwd'])
    useUIStore.getState().openPromptEditor(null)
    render(<PromptEditorDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Add Host' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Same line prompt' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Separator' }))
    await userEvent.click(await screen.findByRole('option', { name: '>' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(useSettingsStore.getState().terminal.prompt).toEqual({
      style: 'pine',
      chips: ['cwd', 'host'],
      sameLine: true,
      separator: '>',
    })
    expect(useUIStore.getState().promptEditor).toBeNull()
  })

  it('leaves the settings alone on Cancel', async () => {
    setChips(['cwd'])
    useUIStore.getState().openPromptEditor(null)
    render(<PromptEditorDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Working directory' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useSettingsStore.getState().terminal.prompt.chips).toEqual(['cwd'])
    expect(useSettingsStore.getState().terminal.prompt.style).toBe('shell')
  })
})
