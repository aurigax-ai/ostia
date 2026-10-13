import { commands } from '@/commands/registry'
import type { PaneNode } from '@/layout/types'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { PromptContext } from '@shared/types'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { SettingsPanel } from '../settings/SettingsPanel'
import { InputEditor } from './InputEditor'

const PANE = 'pane-prompt'

const CONTEXT: PromptContext = {
  user: 'ada',
  host: 'box',
  home: '/home/u',
  virtualEnv: null,
  condaEnv: null,
  nodeVersion: null,
  kubeContext: null,
}

function idlePrompt(): LineAnchor {
  const anchor = { line: 0 }
  useBlocksStore.getState().promptStart(PANE, anchor, '/home/u/proj')
  useBlocksStore.getState().promptEnd(PANE, { line: 0 })
  return anchor
}

function useOstia(chips: string[], patch: { sameLine?: boolean; separator?: '$' | 'none' } = {}) {
  useSettingsStore.setState((s) => ({
    behavior: { ...s.behavior, inputMode: 'editor' },
    terminal: {
      ...s.terminal,
      prompt: { style: 'ostia', chips, sameLine: false, separator: 'none', ...patch },
    },
  }))
}

function editor(cwd = '/home/u/proj') {
  return (
    <InputEditor
      paneId={PANE}
      cwd={cwd}
      fontFamily="monospace"
      fontSize={13}
      alternateScreen={false}
      paneShown
      suppressedPrompt={null}
      ownsFocus={() => true}
      onSubmit={vi.fn(() => true)}
      termRef={{ current: null }}
      hostRef={{ current: null }}
      onHandOff={vi.fn()}
      onShellKeys={vi.fn()}
      onNeedRows={vi.fn()}
    />
  )
}

function renderEditor() {
  return renderSettled(editor())
}

const chipRow = () => screen.getByRole('list', { name: 'Prompt' })

describe('Ostia prompt in the input editor', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let chipsInit: ReturnType<typeof useExtensionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    chipsInit = useExtensionsStore.getState()
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.pty.promptContext).mockResolvedValue(CONTEXT)
  })

  afterEach(() => {
    cleanup()
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    useExtensionsStore.setState(chipsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    vi.mocked(window.ostia.pty.promptContext).mockReset()
  })

  it('leaves the prompt to the shell with the shell prompt style', async () => {
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputMode: 'editor' } }))
    idlePrompt()
    await renderEditor()
    expect(screen.getByRole('textbox', { name: 'Command input' })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Prompt' })).toBeNull()
    expect(window.ostia.pty.promptContext).not.toHaveBeenCalled()
  })

  it('shows the chips in order with the pane’s real values and hides empty ones', async () => {
    useOstia(['user', 'kube', 'cwd', 'exitCode'])
    idlePrompt()
    await renderEditor()
    expect(await within(chipRow()).findByText('ada')).toBeVisible()
    const labels = within(chipRow())
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(labels).toEqual(['ada', '~/proj'])
    expect(window.ostia.pty.promptContext).toHaveBeenCalledWith(PANE, { node: false, kube: true })
  })

  it('shows the last command’s exit code after it finishes', async () => {
    useOstia(['exitCode'])
    idlePrompt()
    useBlocksStore.getState().commandStart(PANE, { line: 1 }, 'false')
    useBlocksStore.getState().commandEnd(PANE, { line: 2 }, 1)
    idlePrompt()
    await renderEditor()
    const chip = await within(chipRow()).findByLabelText('Last exit code: 1')
    expect(chip).toHaveAttribute('data-tone', 'error')
  })

  it('puts the chips and the separator on the input line when sameLine is on', async () => {
    useOstia(['cwd'], { sameLine: true, separator: '$' })
    idlePrompt()
    const { container } = await renderEditor()
    const line = container.querySelector('.input-editor-line')
    expect(line).not.toBeNull()
    expect(line?.contains(chipRow())).toBe(true)
    expect(within(chipRow()).getByText('$')).toBeInTheDocument()
  })

  it('opens Files when the cwd chip is clicked', async () => {
    useOstia(['cwd'])
    idlePrompt()
    await renderEditor()
    await userEvent.click(within(chipRow()).getByRole('button', { name: /Working directory/ }))
    expect(useUIStore.getState().filesOpen).toBe(true)
  })

  it('renders pushed extension pane chips in the order setting and runs their command', async () => {
    const calls: string[] = []
    commands.register({
      id: 'pane.focus',
      title: 'Focus',
      run: (args: { paneId: string }) => {
        calls.push(`focus:${args.paneId}`)
      },
    })
    commands.register({ id: 'vcs.branches', title: 'Branches', run: () => calls.push('branches') })
    useExtensionsStore.setState({
      list: [
        {
          id: 'vcs',
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
          paneChips: [
            { id: 'branch', title: 'Git branch' },
            { id: 'dirty', title: 'Changes' },
          ],
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
        },
      ],
    })
    useOstia(['vcs.dirty', 'cwd', 'vcs.branch'])
    idlePrompt()
    await renderEditor()
    await within(chipRow()).findByText('~/proj')
    expect(
      within(chipRow())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['~/proj'])
    act(() =>
      useExtensionsStore.getState().setChips([
        {
          extId: 'vcs',
          id: 'branch',
          paneId: PANE,
          text: 'main',
          tone: 'neutral',
          command: 'branches',
        },
        { extId: 'vcs', id: 'dirty', paneId: PANE, text: '+2', tone: 'warn' },
        { extId: 'vcs', id: 'branch', paneId: 'other-pane', text: 'dev', tone: 'neutral' },
      ]),
    )
    expect(
      within(chipRow())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['+2', '~/proj', 'main'])
    expect(within(chipRow()).getByText('+2').closest('[data-chip]')).toHaveAttribute(
      'data-tone',
      'warn',
    )
    expect(within(chipRow()).queryByRole('button', { name: /Changes/ })).toBeNull()
    await userEvent.click(
      within(chipRow()).getByRole('button', { name: 'Git branch (extension): main' }),
    )
    await waitFor(() => expect(calls).toEqual([`focus:${PANE}`, 'branches']))
    commands.unregister('pane.focus')
    commands.unregister('vcs.branches')
  })

  it('offers Edit prompt (Settings → Prompt for this pane), Copy prompt and Copy working directory on right-click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    useOstia(['user', 'cwd'], { separator: '$' })
    idlePrompt()
    await renderEditor()
    await within(chipRow()).findByText('ada')
    fireEvent.contextMenu(chipRow())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy prompt' }))
    expect(writeText).toHaveBeenCalledWith('ada ~/proj $')
    fireEvent.contextMenu(chipRow())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy working directory' }))
    expect(writeText).toHaveBeenCalledWith('/home/u/proj')
    fireEvent.contextMenu(chipRow())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit prompt…' }))
    expect(useUIStore.getState()).toMatchObject({
      settingsActive: true,
      settingsSection: 'prompt',
      promptPreviewPaneId: PANE,
    })
  })

  it('asks main again at each new prompt', async () => {
    useOstia(['user'])
    idlePrompt()
    await renderEditor()
    await within(chipRow()).findByText('ada')
    const calls = vi.mocked(window.ostia.pty.promptContext).mock.calls.length
    vi.mocked(window.ostia.pty.promptContext).mockResolvedValue({ ...CONTEXT, user: 'root' })
    act(() => {
      useBlocksStore.getState().commandStart(PANE, { line: 1 }, 'su')
      useBlocksStore.getState().commandEnd(PANE, { line: 2 }, 0)
      useBlocksStore.getState().promptStart(PANE, { line: 3 }, '/home/u/proj')
      useBlocksStore.getState().promptEnd(PANE, { line: 3 })
    })
    expect(await within(chipRow()).findByText('root')).toBeVisible()
    expect(vi.mocked(window.ostia.pty.promptContext).mock.calls.length).toBeGreaterThan(calls)
  })

  it('the Ostia prompt shows chips in the input editor', async () => {
    vi.mocked(window.ostia.pty.promptContext).mockResolvedValue({
      ...CONTEXT,
      virtualEnv: '.venv-ostia',
    })
    const pane = (id: string, cwd: string): PaneNode => ({
      type: 'pane',
      id,
      title: id,
      kind: 'terminal',
      cwd,
    })
    useWorkspacesStore.setState({ activeWorkspaceId: 'w2' })
    useLayoutStore.setState({
      byWorkspace: {
        w1: { root: pane(PANE, '/home/u/ostia_sub'), activePaneId: PANE, zoomedPaneId: null },
        w2: { root: pane('p2', '/home/u/other'), activePaneId: 'p2', zoomedPaneId: null },
      },
    })
    useOstia(['virtualenv', 'cwd', 'exitCode'], { separator: '$' })
    idlePrompt()
    const { rerender } = await renderSettled(
      <>
        {editor('/home/u')}
        <SettingsPanel />
      </>,
    )
    expect(await within(chipRow()).findByLabelText('Python virtualenv: .venv-ostia')).toBeVisible()
    expect(within(chipRow()).getByLabelText('Working directory: ~')).toBeVisible()
    expect(within(chipRow()).queryByLabelText(/Last exit code/)).toBeNull()

    act(() => {
      useBlocksStore
        .getState()
        .commandStart(PANE, { line: 1 }, 'mkdir -p ostia_sub && cd ostia_sub && false')
      useBlocksStore.getState().commandEnd(PANE, { line: 2 }, 1)
      useBlocksStore.getState().promptStart(PANE, { line: 3 }, '/home/u/ostia_sub')
      useBlocksStore.getState().promptEnd(PANE, { line: 3 })
    })
    rerender(
      <>
        {editor('/home/u/ostia_sub')}
        <SettingsPanel />
      </>,
    )
    expect(await within(chipRow()).findByLabelText('Last exit code: 1')).toBeVisible()
    expect(within(chipRow()).getByLabelText('Working directory: ~/ostia_sub')).toBeVisible()

    fireEvent.contextMenu(chipRow())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit prompt…' }))
    const settings = screen.getByRole('region', { name: 'Settings' })
    expect(within(settings).getByRole('heading', { name: 'Prompt', level: 2 })).toBeVisible()
    const preview = within(settings).getByRole('region', { name: 'Preview' })
    expect(await within(preview).findByLabelText('Working directory: ~/ostia_sub')).toBeVisible()
    await userEvent.click(within(settings).getByRole('button', { name: 'Add User' }))
    expect(preview.querySelector('[data-chip="user"]')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    await waitFor(() => expect(chipRow().querySelector('[data-chip="user"]')).not.toBeNull())
  })
})
