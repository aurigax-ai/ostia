import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertCommand } from '../lib/blockActions'
import { registerTerminal } from '../lib/terminalHandles'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useSettingsStore } from '../stores/settingsStore'
import { InputEditor, type InputEditorProps } from './InputEditor'

const PANE = 'pane-input'

function idlePrompt(paneId = PANE): LineAnchor {
  const anchor = { line: 0 }
  useBlocksStore.getState().promptStart(paneId, anchor, '/w')
  useBlocksStore.getState().promptEnd(paneId, { line: 0 })
  return anchor
}

function runCommand(command: string, paneId = PANE): void {
  const s = useBlocksStore.getState()
  s.commandStart(paneId, { line: 1 }, command)
}

function finishCommand(paneId = PANE): LineAnchor {
  useBlocksStore.getState().commandEnd(paneId, { line: 2 }, 0)
  return idlePrompt(paneId)
}

function setMode(inputMode: 'terminal' | 'editor'): void {
  useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputMode } }))
}

function renderEditor(overrides: Partial<InputEditorProps> = {}) {
  const props: InputEditorProps = {
    paneId: PANE,
    cwd: '/home/u/proj',
    fontFamily: 'monospace',
    fontSize: 13,
    alternateScreen: false,
    suppressedPrompt: null,
    ownsFocus: () => true,
    onSubmit: vi.fn(() => true),
    onEscape: vi.fn(),
    ...overrides,
  }
  const view = render(<InputEditor {...props} />)
  return { props, view }
}

const editor = () => screen.queryByRole('textbox', { name: 'Command input' })

describe('InputEditor', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it('stays hidden in terminal mode even at an idle prompt', () => {
    idlePrompt()
    renderEditor()
    expect(editor()).toBeNull()
  })

  it('shows under an idle prompt in editor mode with the cwd and a chord hint', () => {
    setMode('editor')
    idlePrompt()
    renderEditor()
    expect(editor()).toBeVisible()
    expect(editor()).toHaveAttribute('placeholder', 'Run commands')
    expect(screen.getByText('/home/u/proj')).toBeVisible()
    expect(screen.getByText(/Ctrl\+Shift\+H search/)).toBeVisible()
  })

  it('falls back to the terminal when the shell has no integration marks', () => {
    setMode('editor')
    renderEditor()
    expect(editor()).toBeNull()
  })

  it('hides while a command runs and comes back with focus at the next prompt', () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    act(() => editor()?.focus())
    act(() => runCommand('vim'))
    expect(editor()).toBeNull()
    expect(props.onEscape).toHaveBeenCalled()
    act(() => {
      finishCommand()
    })
    expect(editor()).toHaveFocus()
  })

  it('does not take focus when another surface owns it', () => {
    setMode('editor')
    renderEditor({ ownsFocus: () => false })
    act(() => {
      idlePrompt()
    })
    expect(editor()).toBeVisible()
    expect(editor()).not.toHaveFocus()
  })

  it('hides while a full-screen program uses the alternate screen', () => {
    setMode('editor')
    idlePrompt()
    const { view, props } = renderEditor()
    view.rerender(<InputEditor {...props} alternateScreen />)
    expect(editor()).toBeNull()
  })

  it('hides for the prompt the user typed into directly', () => {
    setMode('editor')
    const prompt = idlePrompt()
    const { view, props } = renderEditor()
    view.rerender(<InputEditor {...props} suppressedPrompt={prompt} />)
    expect(editor()).toBeNull()
    act(() => useBlocksStore.getState().promptEnd(PANE, { line: 0 }))
    expect(editor()).toBeNull()
    act(() => {
      runCommand('ls')
      finishCommand()
    })
    expect(editor()).toBeVisible()
  })

  it('appears live when the setting switches to editor', () => {
    idlePrompt()
    renderEditor()
    expect(editor()).toBeNull()
    act(() => setMode('editor'))
    expect(editor()).toBeVisible()
    act(() => setMode('terminal'))
    expect(editor()).toBeNull()
  })

  it('submits on Enter and clears the draft', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'echo hi{Enter}')
    expect(props.onSubmit).toHaveBeenCalledWith('echo hi')
    expect(editor()).toHaveValue('')
  })

  it('keeps the draft when the submit is refused', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor({ onSubmit: vi.fn(() => false) })
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'ls{Enter}')
    expect(props.onSubmit).toHaveBeenCalledWith('ls')
    expect(editor()).toHaveValue('ls')
  })

  it('inserts a newline on Shift+Enter and submits every line together', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'for i in 1 2{Shift>}{Enter}{/Shift}do echo $i; done')
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(editor()).toHaveValue('for i in 1 2\ndo echo $i; done')
    await user.keyboard('{Enter}')
    expect(props.onSubmit).toHaveBeenCalledWith('for i in 1 2\ndo echo $i; done')
  })

  it('walks history with Up (this pane first) and back to the draft with Down', async () => {
    setMode('editor')
    const s = useBlocksStore.getState()
    s.promptStart('other', { line: 0 }, '/w')
    s.commandStart('other', { line: 1 }, 'make build')
    idlePrompt()
    runCommand('git status')
    finishCommand()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'ec')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('git status')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('make build')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('make build')
    await user.keyboard('{ArrowDown}')
    expect(editor()).toHaveValue('git status')
    await user.keyboard('{ArrowDown}')
    expect(editor()).toHaveValue('ec')
  })

  it('moves inside a multi-line draft before walking history, but steps straight through history entries', async () => {
    setMode('editor')
    idlePrompt()
    runCommand('printf a\nprintf b')
    finishCommand()
    runCommand('ls')
    finishCommand()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'one{Shift>}{Enter}{/Shift}two')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('one\ntwo')
    ;(editor() as HTMLTextAreaElement).setSelectionRange(1, 1)
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('ls')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('printf a\nprintf b')
    await user.keyboard('{ArrowDown}')
    expect(editor()).toHaveValue('ls')
  })

  it('clears the draft on Ctrl+C and returns to the terminal on Escape', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'rm -rf build')
    await user.keyboard('{Control>}c{/Control}')
    expect(editor()).toHaveValue('')
    expect(props.onSubmit).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(props.onEscape).toHaveBeenCalledTimes(1)
  })

  it('completes paths from the pane cwd on Tab and lists ambiguous matches', async () => {
    setMode('editor')
    idlePrompt()
    vi.mocked(window.pine.fs.list).mockImplementation(async (path) =>
      path === '/home/u/proj'
        ? [
            { name: 'src', dir: true },
            { name: 'scripts', dir: true },
            { name: 'package.json', dir: false },
          ]
        : [],
    )
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'cat pa')
    await user.keyboard('{Tab}')
    await waitFor(() => expect(editor()).toHaveValue('cat package.json '))
    expect(editor()).toHaveFocus()
    await user.clear(editor() as HTMLElement)
    await user.type(editor() as HTMLElement, 'cd s')
    await user.keyboard('{Tab}')
    expect(await screen.findByText('src/')).toBeVisible()
    expect(screen.getByText('scripts/')).toBeVisible()
    await user.clear(editor() as HTMLElement)
    await user.type(editor() as HTMLElement, 'cd zz')
    await user.keyboard('{Tab}')
    expect(await screen.findByText('No matching paths')).toBeVisible()
    expect(editor()).toHaveFocus()
  })

  it('receives history inserts instead of the shell line while it is shown', async () => {
    setMode('editor')
    idlePrompt()
    const paste = vi.fn()
    const unregister = registerTerminal(PANE, { paste, focus: vi.fn() } as never)
    renderEditor()
    let inserted = false
    act(() => {
      inserted = insertCommand(PANE, 'docker ps')
    })
    expect(inserted).toBe(true)
    expect(paste).not.toHaveBeenCalled()
    expect(editor()).toHaveValue('docker ps')
    expect(editor()).toHaveFocus()
    unregister()
  })
})
