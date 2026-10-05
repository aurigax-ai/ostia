import type { ExtensionInfo } from '@shared/extensions'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { DEFAULT_PROMPT_CHIPS } from '@shared/promptSettings'
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
import { PromptSection } from './PromptSection'

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
  workspaceChips: [],
  settings: [],
  settingValues: {},
  assist: [],
  secrets: [],
  secretsSet: [],
  settingsPage: null,
  category: 'other',
  languages: [],
  languageServers: [],
  agentSkills: [],
  agentHooks: [],
  iconThemes: [],
  keymaps: [],
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

const pane = (id: string, cwd: string, kind: PaneNode['kind'] = 'terminal'): PaneNode => ({
  type: 'pane',
  id,
  title: id,
  kind,
  cwd,
})

function seed(kind: PaneNode['kind'] = 'terminal'): void {
  useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: pane(PANE, '/home/u/proj', kind), activePaneId: PANE, zoomedPaneId: null },
      w2: { root: pane('p2', '/home/u/other'), activePaneId: 'p2', zoomedPaneId: null },
    },
  })
}

function setChips(chips: string[], style: 'shell' | 'ostia' = 'ostia'): void {
  useSettingsStore.setState((s) => ({
    terminal: { ...s.terminal, prompt: { ...s.terminal.prompt, chips, style } },
  }))
}

const saved = () => useSettingsStore.getState().terminal.prompt
const selected = () => screen.getByRole('list', { name: 'In the prompt' })
const selectedIds = () =>
  within(selected())
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-chip'))

describe('PromptSection', () => {
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

  it('previews the active terminal’s real values and marks chips without one', async () => {
    seed()
    setChips(['user', 'kube', 'cwd'])
    render(<PromptSection />)
    const preview = screen.getByRole('region', { name: 'Preview' })
    expect(await within(preview).findByText('ada')).toBeVisible()
    expect(within(preview).getByText('~/proj')).toBeVisible()
    expect(within(preview).getByLabelText('Kubernetes context: no value here')).toHaveAttribute(
      'data-unavailable',
    )
  })

  it('previews the pane Settings was opened from, even outside the active workspace', async () => {
    seed()
    setChips(['cwd'])
    useUIStore.getState().openSettings('prompt', { previewPaneId: 'p2' })
    render(<PromptSection />)
    const preview = screen.getByRole('region', { name: 'Preview' })
    expect(await within(preview).findByText('~/other')).toBeVisible()
  })

  it('falls back to the active terminal when the requested pane is gone', async () => {
    seed()
    setChips(['cwd'])
    useUIStore.getState().openSettings('prompt', { previewPaneId: 'closed-pane' })
    render(<PromptSection />)
    const preview = screen.getByRole('region', { name: 'Preview' })
    expect(await within(preview).findByText('~/proj')).toBeVisible()
  })

  it('shows no preview values without a terminal', () => {
    seed('browser')
    render(<PromptSection />)
    expect(screen.getByText('Open a terminal to preview its values.')).toBeVisible()
    expect(window.pine.pty.promptContext).not.toHaveBeenCalled()
  })

  it('adds, removes and reorders chips with buttons and Alt+arrow keys, saving each change', async () => {
    seed()
    setChips(['cwd', 'user'])
    render(<PromptSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Add Time (24-hour)' }))
    expect(selectedIds()).toEqual(['cwd', 'user', 'time24'])
    expect(saved().chips).toEqual(['cwd', 'user', 'time24'])
    await userEvent.click(screen.getByRole('button', { name: 'Move Time (24-hour) up' }))
    expect(selectedIds()).toEqual(['cwd', 'time24', 'user'])
    const handle = screen.getByRole('button', { name: 'Reorder Working directory' })
    handle.focus()
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(selectedIds()).toEqual(['time24', 'cwd', 'user'])
    expect(saved().chips).toEqual(['time24', 'cwd', 'user'])
    expect(screen.getByRole('button', { name: 'Reorder Working directory' })).toHaveFocus()
    expect(screen.getByText('Working directory moved to position 2')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove User' }))
    expect(selectedIds()).toEqual(['time24', 'cwd'])
    expect(saved().chips).toEqual(['time24', 'cwd'])
    expect(screen.getByRole('button', { name: 'Add User' })).toBeVisible()
  })

  it('lists the pane chips of enabled extensions as available', () => {
    useExtensionsStore.setState({
      list: [
        extension({ id: 'ports', paneChips: [{ id: 'port', title: 'Listening port' }] }),
        extension({ id: 'off', enabled: false, paneChips: [{ id: 'x', title: 'Hidden chip' }] }),
      ],
    })
    render(<PromptSection />)
    expect(screen.getByRole('button', { name: 'Add Listening port (extension)' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add Hidden chip (extension)' })).toBeNull()
  })

  it('places the branch and diff stats chips after the directory by default', () => {
    useExtensionsStore.setState({
      list: [
        extension({
          paneChips: [
            { id: 'branch', title: 'Git branch' },
            { id: 'diff-stats', title: 'Git diff stats' },
          ],
        }),
      ],
    })
    render(<PromptSection />)
    expect(screen.getByRole('button', { name: 'Remove Git branch (extension)' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Remove Git diff stats (extension)' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add Git branch (extension)' })).toBeNull()
  })

  it('applies the style, same line and separator as soon as they change', async () => {
    setChips(['cwd'], 'shell')
    render(<PromptSection />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Prompt style' }))
    await userEvent.click(
      await screen.findByRole('option', { name: `${PRODUCT_DISPLAY_NAME} prompt` }),
    )
    expect(saved().style).toBe('ostia')
    await userEvent.click(screen.getByRole('switch', { name: 'Same line prompt' }))
    expect(saved().sameLine).toBe(true)
    await userEvent.click(screen.getByRole('combobox', { name: 'Separator' }))
    await userEvent.click(await screen.findByRole('option', { name: '>' }))
    expect(saved()).toEqual({ style: 'ostia', chips: ['cwd'], sameLine: true, separator: '>' })
  })

  it('keeps the chip editor under the shell prompt and says when it applies', async () => {
    setChips(['cwd'], 'shell')
    render(<PromptSection />)
    expect(
      screen.getByText(`These chips show when Prompt style is ${PRODUCT_DISPLAY_NAME} prompt.`),
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Add Host' }))
    expect(saved()).toMatchObject({ style: 'shell', chips: ['cwd', 'host'] })
  })

  it('restores the default chips, line and separator without changing the style', async () => {
    useSettingsStore.setState((s) => ({
      terminal: {
        ...s.terminal,
        prompt: { style: 'ostia', chips: ['host'], sameLine: true, separator: '$' },
      },
    }))
    render(<PromptSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(saved()).toEqual({
      style: 'ostia',
      chips: [...DEFAULT_PROMPT_CHIPS],
      sameLine: false,
      separator: 'none',
    })
  })
})
