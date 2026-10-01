import type { PromptContext } from '@shared/types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
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

function usePine(chips: string[], patch: { sameLine?: boolean; separator?: '$' | 'none' } = {}) {
  useSettingsStore.setState((s) => ({
    behavior: { ...s.behavior, inputMode: 'editor' },
    terminal: {
      ...s.terminal,
      prompt: { style: 'pine', chips, sameLine: false, separator: 'none', ...patch },
    },
  }))
}

function renderEditor() {
  return render(
    <InputEditor
      paneId={PANE}
      cwd="/home/u/proj"
      fontFamily="monospace"
      fontSize={13}
      alternateScreen={false}
      suppressedPrompt={null}
      ownsFocus={() => true}
      onSubmit={vi.fn(() => true)}
      termRef={{ current: null }}
      hostRef={{ current: null }}
      onHandOff={vi.fn()}
      onShellKeys={vi.fn()}
      onNeedRows={vi.fn()}
    />,
  )
}

const chipRow = () => screen.getByRole('list', { name: 'Prompt' })

describe('Pine prompt in the input editor', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let chipsInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    chipsInit = useExtensionsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.pine.pty.promptContext).mockResolvedValue(CONTEXT)
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    useExtensionsStore.setState(chipsInit, true)
    vi.mocked(window.pine.pty.promptContext).mockReset()
  })

  it('leaves the prompt to the shell with the shell prompt style', () => {
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputMode: 'editor' } }))
    idlePrompt()
    renderEditor()
    expect(screen.getByRole('textbox', { name: 'Command input' })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Prompt' })).toBeNull()
    expect(window.pine.pty.promptContext).not.toHaveBeenCalled()
  })

  it('shows the chips in order with the pane’s real values and hides empty ones', async () => {
    usePine(['user', 'kube', 'cwd', 'exitCode'])
    idlePrompt()
    renderEditor()
    expect(await within(chipRow()).findByText('ada')).toBeVisible()
    const labels = within(chipRow())
      .getAllByRole('listitem')
      .map((li) => li.textContent)
    expect(labels).toEqual(['ada', '~/proj'])
    expect(window.pine.pty.promptContext).toHaveBeenCalledWith(PANE, { node: false, kube: true })
  })

  it('shows the last command’s exit code after it finishes', async () => {
    usePine(['exitCode'])
    idlePrompt()
    useBlocksStore.getState().commandStart(PANE, { line: 1 }, 'false')
    useBlocksStore.getState().commandEnd(PANE, { line: 2 }, 1)
    idlePrompt()
    renderEditor()
    const chip = await within(chipRow()).findByLabelText('Last exit code: 1')
    expect(chip).toHaveAttribute('data-tone', 'error')
  })

  it('puts the chips and the separator on the input line when sameLine is on', async () => {
    usePine(['cwd'], { sameLine: true, separator: '$' })
    idlePrompt()
    const { container } = renderEditor()
    const line = container.querySelector('.input-editor-line')
    expect(line).not.toBeNull()
    expect(line?.contains(chipRow())).toBe(true)
    expect(within(chipRow()).getByText('$')).toBeInTheDocument()
  })

  it('opens Files when the cwd chip is clicked', async () => {
    usePine(['cwd'])
    idlePrompt()
    renderEditor()
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
    commands.register({ id: 'git.branches', title: 'Branches', run: () => calls.push('branches') })
    useExtensionsStore.setState({
      list: [
        {
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
          paneChips: [
            { id: 'branch', title: 'Git branch' },
            { id: 'dirty', title: 'Changes' },
          ],
          settings: [],
          settingValues: {},
          assist: [],
          secrets: [],
          secretsSet: [],
          category: 'other',
          iconThemes: [],
        },
      ],
    })
    usePine(['git.dirty', 'cwd', 'git.branch'])
    idlePrompt()
    renderEditor()
    await within(chipRow()).findByText('~/proj')
    expect(
      within(chipRow())
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['~/proj'])
    act(() =>
      useExtensionsStore.getState().setChips([
        {
          extId: 'git',
          id: 'branch',
          paneId: PANE,
          text: 'main',
          tone: 'neutral',
          command: 'branches',
        },
        { extId: 'git', id: 'dirty', paneId: PANE, text: '+2', tone: 'warn' },
        { extId: 'git', id: 'branch', paneId: 'other-pane', text: 'dev', tone: 'neutral' },
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
    commands.unregister('git.branches')
  })

  it('offers Edit prompt (Settings → Prompt for this pane), Copy prompt and Copy working directory on right-click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    usePine(['user', 'cwd'], { separator: '$' })
    idlePrompt()
    renderEditor()
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
    usePine(['user'])
    idlePrompt()
    renderEditor()
    await within(chipRow()).findByText('ada')
    const calls = vi.mocked(window.pine.pty.promptContext).mock.calls.length
    vi.mocked(window.pine.pty.promptContext).mockResolvedValue({ ...CONTEXT, user: 'root' })
    act(() => {
      useBlocksStore.getState().commandStart(PANE, { line: 1 }, 'su')
      useBlocksStore.getState().commandEnd(PANE, { line: 2 }, 0)
      useBlocksStore.getState().promptStart(PANE, { line: 3 }, '/home/u/proj')
      useBlocksStore.getState().promptEnd(PANE, { line: 3 })
    })
    expect(await within(chipRow()).findByText('root')).toBeVisible()
    expect(vi.mocked(window.pine.pty.promptContext).mock.calls.length).toBeGreaterThan(calls)
  })
})
