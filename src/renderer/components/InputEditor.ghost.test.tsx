import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { InputEditor, type InputEditorProps } from './InputEditor'

const PANE = 'pane-ghost'
const PROVIDER = {
  extId: 'assistant',
  name: 'Assistant',
  label: 'model-runtime · gemma',
  ref: { extId: 'assistant' },
}
const WAIT = { timeout: 5000 }

function assistOn(on = true): void {
  useAssistStore.setState({
    availability: { terminal: PROVIDER },
    overview: [
      {
        extId: 'assistant',
        name: 'Assistant',
        setup: null,
        models: false,
        providers: [],
        kinds: [],
        keysSet: [],
        features: [{ id: 'terminalCompletions', setting: 'terminalCompletions', on, ready: true }],
      },
    ],
  })
}

function renderEditor(): InputEditorProps {
  useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputMode: 'editor' } }))
  useBlocksStore.getState().promptStart(PANE, { line: 0 }, '/w')
  useBlocksStore.getState().promptEnd(PANE, { line: 0 })
  const props: InputEditorProps = {
    paneId: PANE,
    cwd: '/home/u/proj',
    fontFamily: 'monospace',
    fontSize: 13,
    alternateScreen: false,
    paneShown: true,
    suppressedPrompt: null,
    ownsFocus: () => true,
    termRef: {
      current: {
        focus: vi.fn(),
        getSelection: () => '',
        hasSelection: () => false,
        scrollToBottom: vi.fn(),
      } as never,
    } as { current: Xterm },
    hostRef: { current: null },
    onSubmit: vi.fn(() => true),
    onHandOff: vi.fn(),
    onShellKeys: vi.fn(),
    onNeedRows: vi.fn(),
  }
  render(<InputEditor {...props} />)
  return props
}

function ghost(): HTMLElement | null {
  return document.querySelector('.input-editor-ghost')
}

describe('InputEditor AI ghost completion', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
    extensionsInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    useAssistStore.setState({ availability: {}, overview: [] })
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.pty.write).mockClear()
  })

  it('shows the continuation as ghost text and Tab puts it in the draft without running it', async () => {
    assistOn()
    vi.mocked(window.ostia.assist.request).mockResolvedValue({
      ok: true,
      result: { text: ' log --oneline' },
    } as never)
    const props = renderEditor()
    const area = screen.getByRole('textbox', { name: 'Command input' })
    await userEvent.type(area, 'git')
    await waitFor(() => expect(ghost()).toHaveTextContent('log --oneline'), WAIT)
    expect(ghost()).toHaveAttribute('data-ghost', 'ai')
    expect(window.ostia.assist.request).toHaveBeenCalledWith(
      'terminal',
      expect.any(String),
      expect.objectContaining({ line: 'git', cwd: '/home/u/proj' }),
    )
    await userEvent.keyboard('{Tab}')
    expect(area).toHaveValue('git log --oneline')
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(window.ostia.pty.write).not.toHaveBeenCalledWith(PANE, '\r')
  })

  it('lets a history prefix match win over the AI', async () => {
    assistOn()
    const block = {
      id: 'b1',
      paneId: PANE,
      command: 'git status --short',
      exitCode: 0,
      cwd: '/w',
      startedAt: 1,
      endLine: { line: 1 },
    } as unknown as CommandBlock
    useBlocksStore.setState({ byPane: { [PANE]: [block] } })
    vi.mocked(window.ostia.assist.request).mockResolvedValue({
      ok: true,
      result: { text: ' stash' },
    } as never)
    renderEditor()
    await userEvent.type(screen.getByRole('textbox', { name: 'Command input' }), 'git st')
    await waitFor(() => expect(ghost()).toHaveTextContent('atus --short'), WAIT)
    expect(ghost()).toHaveAttribute('data-ghost', 'history')
    await new Promise((r) => setTimeout(r, 450))
    expect(window.ostia.assist.request).not.toHaveBeenCalled()
  })

  it('asks nothing while terminal completions are switched off', async () => {
    assistOn(false)
    renderEditor()
    await userEvent.type(screen.getByRole('textbox', { name: 'Command input' }), 'docker')
    await new Promise((r) => setTimeout(r, 450))
    expect(window.ostia.assist.request).not.toHaveBeenCalled()
    expect(ghost()).toBeNull()
  })

  it('turns terminal completions off from the input right-click menu', async () => {
    assistOn()
    const setSetting = vi.fn().mockResolvedValue(null)
    useExtensionsStore.setState({ setSetting })
    renderEditor()
    const area = screen.getByRole('textbox', { name: 'Command input' })
    await userEvent.pointer({ keys: '[MouseRight]', target: area })
    const toggle = await screen.findByRole('menuitemcheckbox', { name: 'Assistant completions' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    expect(setSetting).toHaveBeenCalledWith('assistant', 'terminalCompletions', false)
  })
})
