import type { PromptContext } from '@shared/types'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { usePaneChipsStore } from '../stores/paneChipsStore'
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
      workspaceId="ws-prompt"
      cwd="/home/u/proj"
      fontFamily="monospace"
      fontSize={13}
      alternateScreen={false}
      suppressedPrompt={null}
      ownsFocus={() => true}
      onSubmit={vi.fn(() => true)}
      onEscape={vi.fn()}
    />,
  )
}

const chipRow = () => screen.getByRole('list', { name: 'Prompt' })

describe('Pine prompt in the input editor', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let chipsInit: ReturnType<typeof usePaneChipsStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    chipsInit = usePaneChipsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.pine.pty.promptContext).mockResolvedValue(CONTEXT)
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    usePaneChipsStore.setState(chipsInit, true)
    vi.mocked(window.pine.pty.promptContext).mockReset()
  })

  it('keeps the lone cwd line with the shell prompt style', () => {
    useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputMode: 'editor' } }))
    idlePrompt()
    renderEditor()
    expect(screen.getByText('/home/u/proj')).toBeVisible()
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

  it('renders an extension chip where its id sits and runs its command on click', async () => {
    const invoke = vi.mocked(window.pine.extensions.invoke)
    invoke.mockResolvedValue(undefined as never)
    usePaneChipsStore.setState({
      byPane: { [PANE]: [{ extId: 'git', id: 'branch', text: 'main', command: 'branches' }] },
      catalog: [{ extId: 'git', id: 'branch', title: 'Git branch' }],
    })
    usePine(['git.branch', 'cwd'])
    idlePrompt()
    renderEditor()
    await within(chipRow()).findByText('~/proj')
    const items = within(chipRow()).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual(['main', '~/proj'])
    await userEvent.click(
      within(chipRow()).getByRole('button', { name: 'Git branch (extension): main' }),
    )
    expect(invoke).toHaveBeenCalledWith('git', 'branches', {
      workspaceId: 'ws-prompt',
      paneId: PANE,
    })
  })

  it('offers Edit prompt, Copy prompt and Copy working directory on right-click', async () => {
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
    expect(useUIStore.getState().promptEditor).toEqual({ paneId: PANE })
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
