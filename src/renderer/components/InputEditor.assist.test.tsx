import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useSettingsStore } from '../stores/settingsStore'
import { InputEditor, type InputEditorProps } from './InputEditor'

const PANE = 'pane-natural'
const PROVIDER = {
  extId: 'assistant',
  name: 'Assistant',
  label: 'ollama · qwen',
  ref: { extId: 'assistant' },
}
const WAIT = { timeout: 5000 }

function renderEditor() {
  useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputMode: 'editor' } }))
  useBlocksStore.getState().promptStart(PANE, { line: 0 }, '/w')
  useBlocksStore.getState().promptEnd(PANE, { line: 0 })
  const props: InputEditorProps = {
    paneId: PANE,
    cwd: '/home/u/proj',
    fontFamily: 'monospace',
    fontSize: 13,
    alternateScreen: false,
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

describe('InputEditor natural-language commands', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
    useAssistStore.setState({ availability: {} })
    vi.mocked(window.pine.assist.request).mockReset()
  })

  it('suggests a command for a "# " draft and replaces the draft only on Tab', async () => {
    useAssistStore.setState({ availability: { command: PROVIDER } })
    vi.mocked(window.pine.assist.request).mockResolvedValue({
      ok: true,
      result: { suggestions: [{ command: 'git log --oneline -5', description: 'Last five' }] },
    } as never)
    const props = renderEditor()
    const area = screen.getByRole('textbox', { name: 'Command input' })
    await userEvent.type(area, '# show last five commits')
    expect(await screen.findByText('git log --oneline -5', {}, WAIT)).toBeInTheDocument()
    expect(area).toHaveValue('# show last five commits')
    expect(window.pine.assist.request).toHaveBeenCalledWith(
      'command',
      expect.any(String),
      expect.objectContaining({ query: 'show last five commits', cwd: '/home/u/proj' }),
    )
    await userEvent.keyboard('{Tab}')
    expect(area).toHaveValue('git log --oneline -5')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('asks nothing without a command provider', async () => {
    renderEditor()
    await userEvent.type(screen.getByRole('textbox', { name: 'Command input' }), '# list files')
    await new Promise((r) => setTimeout(r, 800))
    expect(window.pine.assist.request).not.toHaveBeenCalled()
  })

  it('dismisses the suggestion on Escape and keeps the draft', async () => {
    useAssistStore.setState({ availability: { command: PROVIDER } })
    vi.mocked(window.pine.assist.request).mockResolvedValue({
      ok: true,
      result: { suggestions: [{ command: 'ls -la' }] },
    } as never)
    const props = renderEditor()
    const area = screen.getByRole('textbox', { name: 'Command input' })
    await userEvent.type(area, '# list all files')
    await screen.findByText('ls -la', {}, WAIT)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText('ls -la')).toBeNull())
    expect(area).toHaveValue('# list all files')
    expect(props.onHandOff).not.toHaveBeenCalled()
  })
})
