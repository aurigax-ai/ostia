import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { insertCommand } from '../lib/blockActions'
import { inputEditorFor, registerTerminal } from '../lib/terminalHandles'
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

function fakeTerm(selection = ''): Xterm {
  return {
    focus: vi.fn(),
    getSelection: () => selection,
    hasSelection: () => selection !== '',
    clearSelection: vi.fn(),
    scrollToBottom: vi.fn(),
  } as unknown as Xterm
}

function setClipboardKeys(clipboardKeys: 'shift' | 'smart'): void {
  useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, clipboardKeys } }))
}

function renderEditor(overrides: Partial<InputEditorProps> = {}) {
  const props: InputEditorProps = {
    paneId: PANE,
    cwd: '/home/u/proj',
    fontFamily: 'monospace',
    fontSize: 13,
    alternateScreen: false,
    paneShown: true,
    suppressedPrompt: null,
    ownsFocus: () => true,
    termRef: { current: fakeTerm() },
    hostRef: { current: null },
    onSubmit: vi.fn(() => true),
    onHandOff: vi.fn(),
    onShellKeys: vi.fn(),
    onNeedRows: vi.fn(),
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
    cleanup()
    useBlocksStore.setState(blocksInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it('stays hidden in terminal mode even at an idle prompt', () => {
    idlePrompt()
    renderEditor()
    expect(editor()).toBeNull()
  })

  it('shows at an idle prompt in editor mode', () => {
    setMode('editor')
    idlePrompt()
    renderEditor()
    expect(editor()).toBeVisible()
    expect(editor()).toHaveAttribute('placeholder', 'Run commands')
  })

  it('falls back to the terminal when the shell has no integration marks', () => {
    setMode('editor')
    renderEditor()
    expect(editor()).toBeNull()
  })

  it('SSH-C37 leaves a remote shell’s prompt to the terminal and comes back at a local prompt', () => {
    setMode('editor')
    act(() => {
      useBlocksStore.getState().promptStart(PANE, { line: 0 }, null, true)
      useBlocksStore.getState().promptEnd(PANE, { line: 0 })
    })
    renderEditor()
    expect(editor()).toBeNull()
    act(() => {
      idlePrompt()
    })
    expect(editor()).toBeVisible()
  })

  it('hides while a command runs and comes back with focus at the next prompt', () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    act(() => editor()?.focus())
    act(() => runCommand('vim'))
    expect(editor()).toBeNull()
    expect(props.termRef.current?.focus).toHaveBeenCalled()
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
    await user.click(editor() as HTMLElement)
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('git status')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('make build')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('make build')
    await user.keyboard('{ArrowDown}')
    expect(editor()).toHaveValue('git status')
    await user.keyboard('{ArrowDown}')
    expect(editor()).toHaveValue('')
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
    await user.keyboard('{Control>}c{/Control}')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('ls')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('printf a\nprintf b')
    await user.keyboard('{ArrowDown}')
    expect(editor()).toHaveValue('ls')
  })

  it('runs a chord that acts only in a terminal, such as Ctrl+Shift+K, and keeps it from the window', async () => {
    setMode('editor')
    idlePrompt()
    const run = vi.fn()
    commands.register({ id: 'terminal.clear', title: 'Clear Terminal', run })
    const behind = vi.fn((e: KeyboardEvent) => e.code)
    try {
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'ls')
      window.addEventListener('keydown', behind)
      await user.keyboard('{Control>}{Shift>}K{/Shift}{/Control}')
      await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
      expect(behind.mock.results.map((r) => r.value)).not.toContain('KeyK')
      expect(editor()).toHaveValue('ls')
    } finally {
      window.removeEventListener('keydown', behind)
      commands.unregister('terminal.clear')
    }
  })

  it('clears the draft on Ctrl+C and hands the draft to the shell line on Escape', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'rm -rf build')
    await user.keyboard('{Control>}c{/Control}')
    expect(editor()).toHaveValue('')
    expect(props.onSubmit).not.toHaveBeenCalled()
    await user.type(editor() as HTMLElement, 'git st')
    await user.keyboard('{Escape}')
    expect(props.onHandOff).toHaveBeenCalledTimes(1)
    expect(props.onHandOff).toHaveBeenCalledWith('git st', '')
  })

  it('copies the selected draft text on smart Ctrl+C and keeps the draft', async () => {
    setMode('editor')
    setClipboardKeys('smart')
    idlePrompt()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'git status')
    const area = editor() as HTMLTextAreaElement
    area.setSelectionRange(4, 10)
    await user.keyboard('{Control>}c{/Control}')
    expect(editor()).toHaveValue('git status')
    await expect(navigator.clipboard.readText()).resolves.toBe('status')
  })

  it('copies the terminal selection on smart Ctrl+C when the draft has none', async () => {
    setMode('editor')
    setClipboardKeys('smart')
    idlePrompt()
    const term = fakeTerm('build output')
    renderEditor({ termRef: { current: term } })
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'make')
    await user.keyboard('{Control>}c{/Control}')
    expect(editor()).toHaveValue('make')
    await expect(navigator.clipboard.readText()).resolves.toBe('build output')
    expect(term.clearSelection).toHaveBeenCalled()
  })

  it('clears the draft on smart Ctrl+C when nothing is selected', async () => {
    setMode('editor')
    setClipboardKeys('smart')
    idlePrompt()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'rm -rf build')
    await user.keyboard('{Control>}c{/Control}')
    expect(editor()).toHaveValue('')
  })

  it('keeps Ctrl+C as the shell clear in shift mode even with a selection', async () => {
    setMode('editor')
    setClipboardKeys('shift')
    idlePrompt()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'git status')
    ;(editor() as HTMLTextAreaElement).setSelectionRange(0, 3)
    await user.keyboard('{Control>}c{/Control}')
    expect(editor()).toHaveValue('')
  })

  it('copies the selection on the copy chord in either mode', async () => {
    setMode('editor')
    idlePrompt()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'git status')
    ;(editor() as HTMLTextAreaElement).setSelectionRange(0, 3)
    await user.keyboard('{Control>}{Shift>}C{/Shift}{/Control}')
    expect(editor()).toHaveValue('git status')
    await expect(navigator.clipboard.readText()).resolves.toBe('git')
  })

  it('pastes into the draft without control characters or a trailing newline', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.click(editor() as HTMLElement)
    await user.paste('echo hi\x1b[201~\n')
    expect(editor()).toHaveValue('echo hi[201~')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('edits with readline keys and a kill ring', async () => {
    setMode('editor')
    idlePrompt()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'echo hello world')
    await user.keyboard('{Control>}w{/Control}')
    expect(editor()).toHaveValue('echo hello ')
    await user.keyboard('{Control>}a{/Control}')
    await user.keyboard('{Control>}k{/Control}')
    expect(editor()).toHaveValue('')
    await user.keyboard('{Control>}y{/Control}')
    expect(editor()).toHaveValue('echo hello ')
    await user.keyboard('{Control>}u{/Control}')
    expect(editor()).toHaveValue('')
  })

  it('hands the draft and the key to the shell for widgets it does not own, like Ctrl+R', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'git')
    await user.keyboard('{Control>}r{/Control}')
    expect(props.onHandOff).toHaveBeenCalledWith('git', '\x12')
    expect(editor()).toHaveValue('')
  })

  it('sends Ctrl+L to the shell and keeps the draft, and Ctrl+D on an empty draft as EOF', async () => {
    setMode('editor')
    idlePrompt()
    const { props } = renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'ls')
    await user.keyboard('{Control>}l{/Control}')
    expect(props.onShellKeys).toHaveBeenCalledWith('\x0c')
    expect(editor()).toHaveValue('ls')
    await user.keyboard('{Control>}u{/Control}')
    await user.keyboard('{Control>}d{/Control}')
    expect(props.onHandOff).toHaveBeenCalledWith('', '\x04')
  })

  it('filters history by the typed prefix on Up', async () => {
    setMode('editor')
    idlePrompt()
    act(() => {
      runCommand('git status')
      finishCommand()
      runCommand('ls -la')
      finishCommand()
      runCommand('git log')
      finishCommand()
    })
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'git s')
    await user.keyboard('{ArrowUp}')
    expect(editor()).toHaveValue('git status')
  })

  it('takes typing and pastes forwarded from the terminal while it is shown', async () => {
    setMode('editor')
    idlePrompt()
    renderEditor()
    await act(async () => {})
    const area = editor() as HTMLTextAreaElement
    act(() => {
      area.blur()
    })
    act(() => inputEditorFor(PANE)?.type('ls'))
    act(() => inputEditorFor(PANE)?.type(' -la'))
    expect(area).toHaveValue('ls -la')
    expect(area).toHaveFocus()
  })

  it('completes paths from the pane cwd on Tab and lists ambiguous matches', async () => {
    setMode('editor')
    idlePrompt()
    vi.mocked(window.ostia.pty.listDir).mockImplementation(async (_pane, path) =>
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
    expect(await screen.findByRole('option', { name: 'src/' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'scripts/' })).toBeVisible()
    await user.clear(editor() as HTMLElement)
    await user.type(editor() as HTMLElement, 'cd zz')
    await user.keyboard('{Tab}')
    expect(await screen.findByText('No matching paths')).toBeVisible()
    expect(editor()).toHaveFocus()
  })

  it('completes subcommands and options from the command’s spec with descriptions', async () => {
    setMode('editor')
    idlePrompt()
    vi.mocked(window.ostia.completions.spec).mockImplementation(async (command) =>
      command === 'git'
        ? {
            names: ['git'],
            subcommands: [
              {
                names: ['checkout'],
                description: 'Switch branches',
                options: [{ names: ['--force'], description: 'Throw away local changes' }],
              },
              { names: ['cherry-pick'], description: 'Apply a commit' },
              { names: ['add'], args: [{ template: ['filepaths'] }] },
            ],
          }
        : null,
    )
    vi.mocked(window.ostia.pty.listDir).mockResolvedValue([{ name: 'package.json', dir: false }])
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor() as HTMLElement, 'git ch')
    await user.keyboard('{Tab}')
    expect(await screen.findByText('Switch branches')).toBeVisible()
    expect(screen.getByText('Apply a commit')).toBeVisible()
    expect(editor()).toHaveValue('git che')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(editor()).toHaveValue('git checkout '))
    await user.type(editor() as HTMLElement, '--f')
    await user.keyboard('{Tab}')
    await waitFor(() => expect(editor()).toHaveValue('git checkout --force '))
    await user.clear(editor() as HTMLElement)
    await user.type(editor() as HTMLElement, 'git add pa')
    await user.keyboard('{Tab}')
    await waitFor(() => expect(editor()).toHaveValue('git add package.json '))
    vi.mocked(window.ostia.completions.spec).mockReset()
    vi.mocked(window.ostia.pty.listDir).mockReset()
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

  describe('autosuggestions', () => {
    const ghost = () => document.querySelector('.input-editor-ghost')?.textContent ?? null

    function withHistory(...commands: string[]): void {
      setMode('editor')
      idlePrompt()
      for (const command of commands) {
        runCommand(command)
        finishCommand()
      }
    }

    it('shows the newest matching command as ghost text and accepts it with Right or End', async () => {
      withHistory('git status --short', 'git stash list')
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'git st')
      expect(ghost()).toBe('ash list')
      await user.keyboard('{ArrowRight}')
      expect(editor()).toHaveValue('git stash list')
      expect(ghost()).toBeNull()
      await user.clear(editor() as HTMLElement)
      await user.type(editor() as HTMLElement, 'git status')
      expect(ghost()).toBe(' --short')
      await user.keyboard('{End}')
      expect(editor()).toHaveValue('git status --short')
    })

    it('shows no history ghost text while behavior.historySuggestions is off', async () => {
      useSettingsStore.setState({
        behavior: { ...useSettingsStore.getState().behavior, historySuggestions: false },
      })
      withHistory('git status --short')
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'git st')
      expect(ghost()).toBeNull()
      await user.keyboard('{ArrowRight}')
      expect(editor()).toHaveValue('git st')
    })

    it('prefers this pane’s history over other panes', async () => {
      const s = useBlocksStore.getState()
      s.promptStart('other', { line: 0 }, '/w')
      s.commandStart('other', { line: 1 }, 'npm run lint')
      withHistory('npm test')
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'npm ')
      expect(ghost()).toBe('test')
      await user.type(editor() as HTMLElement, 'r')
      expect(ghost()).toBe('un lint')
    })

    it('accepts one word with Ctrl+Right', async () => {
      withHistory('docker compose up -d')
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'dock')
      await user.keyboard('{Control>}{ArrowRight}{/Control}')
      expect(editor()).toHaveValue('docker')
      await user.keyboard('{Control>}{ArrowRight}{/Control}')
      expect(editor()).toHaveValue('docker compose')
      expect(ghost()).toBe(' up -d')
    })

    it('dismisses on Escape without leaving the editor, and drops it when typing diverges', async () => {
      withHistory('make build')
      const { props } = renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'ma')
      expect(ghost()).toBe('ke build')
      await user.keyboard('{Escape}')
      expect(ghost()).toBeNull()
      expect(props.onHandOff).not.toHaveBeenCalled()
      await user.type(editor() as HTMLElement, 'k')
      expect(ghost()).toBe('e build')
      await user.type(editor() as HTMLElement, 'x')
      expect(ghost()).toBeNull()
      await user.keyboard('{ArrowRight}')
      expect(editor()).toHaveValue('makx')
    })

    it('shows no suggestion while the caret is inside the draft', async () => {
      withHistory('echo hello')
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'echo')
      expect(ghost()).toBe(' hello')
      await user.keyboard('{ArrowLeft}')
      expect(ghost()).toBeNull()
    })
  })

  describe('command completion', () => {
    it('completes a unique command name on Tab and paths after it', async () => {
      setMode('editor')
      idlePrompt()
      vi.mocked(window.ostia.pty.commands).mockResolvedValue(['docker', 'git', 'grep'])
      vi.mocked(window.ostia.pty.listDir).mockResolvedValue([{ name: 'Dockerfile', dir: false }])
      renderEditor()
      await waitFor(() => expect(window.ostia.pty.commands).toHaveBeenCalledWith(PANE))
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'doc')
      await user.keyboard('{Tab}')
      await waitFor(() => expect(editor()).toHaveValue('docker '))
      await user.keyboard('Dock{Tab}')
      await waitFor(() => expect(editor()).toHaveValue('docker Dockerfile '))
    })

    it('opens a menu for several matches, picks with arrows and Enter, and closes on Escape', async () => {
      setMode('editor')
      idlePrompt()
      vi.mocked(window.ostia.pty.commands).mockResolvedValue(['gitk', 'git', 'gist', 'ls'])
      const { props } = renderEditor()
      await waitFor(() => expect(window.ostia.pty.commands).toHaveBeenCalled())
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'gi')
      await user.keyboard('{Tab}')
      const menu = await screen.findByRole('listbox', { name: 'Completions' })
      const options = screen.getAllByRole('option').map((o) => o.textContent)
      expect(options).toEqual(['git', 'gist', 'gitk'])
      expect(menu).toBeVisible()
      expect(screen.getByRole('option', { name: 'git' })).toHaveAttribute('aria-selected', 'true')
      await user.keyboard('{ArrowDown}')
      expect(screen.getByRole('option', { name: 'gist' })).toHaveAttribute('aria-selected', 'true')
      await waitFor(() =>
        expect(editor()).toHaveAttribute(
          'aria-activedescendant',
          screen.getByRole('option', { name: 'gist' }).id,
        ),
      )
      await user.keyboard('{Enter}')
      expect(editor()).toHaveValue('gist ')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(props.onSubmit).not.toHaveBeenCalled()

      await user.clear(editor() as HTMLElement)
      await user.type(editor() as HTMLElement, 'gi')
      await user.keyboard('{Tab}')
      await screen.findByRole('listbox')
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(props.onHandOff).not.toHaveBeenCalled()
      expect(editor()).toHaveValue('gi')
    })

    it('reports when no command matches', async () => {
      setMode('editor')
      idlePrompt()
      vi.mocked(window.ostia.pty.commands).mockResolvedValue(['ls'])
      renderEditor()
      await waitFor(() => expect(window.ostia.pty.commands).toHaveBeenCalled())
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'zzz')
      await user.keyboard('{Tab}')
      expect(await screen.findByText('No matching commands')).toBeVisible()
    })
  })

  describe('live completion', () => {
    const options = () => screen.queryAllByRole('option').map((o) => o.textContent)

    function folders(): void {
      vi.mocked(window.ostia.pty.listDir).mockReset()
      vi.mocked(window.ostia.pty.listDir).mockImplementation(async (_pane, path) => {
        if (path === '/home/u/proj') {
          return [
            { name: 'avail', dir: true },
            { name: 'avail-mock-feat', dir: true },
            { name: 'avail-mock-qa', dir: true },
            { name: 'other', dir: true },
          ]
        }
        if (path === '/home/u/proj/avail') {
          return [
            { name: 'src', dir: true },
            { name: 'docs', dir: true },
          ]
        }
        return []
      })
    }

    async function openAvail() {
      setMode('editor')
      idlePrompt()
      folders()
      const rendered = renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'cd av')
      await user.keyboard('{Tab}')
      await screen.findByRole('listbox', { name: 'Completions' })
      expect(editor()).toHaveValue('cd avail')
      return { user, ...rendered }
    }

    it('keeps the menu open and narrows it while typing, without listing the folder again', async () => {
      const { user } = await openAvail()
      expect(options()).toEqual(['avail/', 'avail-mock-feat/', 'avail-mock-qa/'])
      await user.keyboard('-m')
      expect(options()).toEqual(['avail-mock-feat/', 'avail-mock-qa/'])
      await user.keyboard('q')
      expect(options()).toEqual(['avail-mock-qa/'])
      const row = screen.getByRole('option', { name: 'avail-mock-qa/' })
      expect(
        Array.from(row.querySelectorAll('.input-editor-menu-match'), (m) => m.textContent),
      ).toEqual(['avail-m', 'q'])
      expect(window.ostia.pty.listDir).toHaveBeenCalledTimes(1)
    })

    it('widens on Backspace, hides when nothing matches and comes back when something does', async () => {
      const { user } = await openAvail()
      await user.keyboard('-mq')
      expect(options()).toEqual(['avail-mock-qa/'])
      await user.keyboard('{Backspace}')
      expect(options()).toEqual(['avail-mock-feat/', 'avail-mock-qa/'])
      await user.keyboard('zz')
      expect(screen.queryByRole('listbox')).toBeNull()
      await user.keyboard('{Backspace}{Backspace}')
      expect(options()).toEqual(['avail-mock-feat/', 'avail-mock-qa/'])
    })

    it('keeps the selected item selected while it still matches', async () => {
      const { user } = await openAvail()
      await user.keyboard('{ArrowDown}{ArrowDown}')
      expect(screen.getByRole('option', { name: 'avail-mock-qa/' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      await user.keyboard('-m')
      expect(screen.getByRole('option', { name: 'avail-mock-qa/' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })

    it('closes when the word ends with a space and stays closed after deleting it', async () => {
      const { user } = await openAvail()
      await user.keyboard(' ')
      expect(screen.queryByRole('listbox')).toBeNull()
      await user.keyboard('{Backspace}')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(editor()).toHaveValue('cd avail')
    })

    it('closes on Escape without handing off, and Backspace does not bring it back', async () => {
      const { user, props } = await openAvail()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(props.onHandOff).not.toHaveBeenCalled()
      await user.keyboard('{Backspace}')
      expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('closes when the caret leaves the word with Home', async () => {
      const { user } = await openAvail()
      await user.keyboard('{Home}')
      expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('picks the filtered item with Enter without running the draft', async () => {
      const { user, props } = await openAvail()
      await user.keyboard('-m{ArrowDown}{Enter}')
      expect(editor()).toHaveValue('cd avail-mock-qa/')
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(props.onSubmit).not.toHaveBeenCalled()
    })

    it('lists the new folder when a typed slash moves into it, without inserting anything', async () => {
      const { user } = await openAvail()
      await user.keyboard('/')
      await waitFor(() => expect(options()).toEqual(['src/', 'docs/']))
      expect(window.ostia.pty.listDir).toHaveBeenLastCalledWith(PANE, '/home/u/proj/avail')
      expect(editor()).toHaveValue('cd avail/')
      await user.keyboard('d')
      expect(options()).toEqual(['docs/'])
      await user.keyboard('{Tab}')
      expect(editor()).toHaveValue('cd avail/docs/')
    })

    it('filters command names live too', async () => {
      setMode('editor')
      idlePrompt()
      vi.mocked(window.ostia.pty.commands).mockResolvedValue(['gitk', 'git', 'gist', 'ls'])
      renderEditor()
      await waitFor(() => expect(window.ostia.pty.commands).toHaveBeenCalled())
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'gi')
      await user.keyboard('{Tab}')
      await screen.findByRole('listbox', { name: 'Completions' })
      expect(options()).toEqual(['git', 'gist', 'gitk'])
      await user.keyboard('s')
      expect(options()).toEqual(['gist'])
      await user.keyboard('{Backspace}k')
      expect(options()).toEqual(['gitk'])
      await user.keyboard('{Enter}')
      expect(editor()).toHaveValue('gitk ')
    })
  })

  describe('syntax highlighting', () => {
    const tokens = () =>
      [...screen.getByTestId('input-editor-highlight').querySelectorAll('[data-token]')]
        .filter((el) => el.getAttribute('data-token') !== 'space')
        .map((el) => [el.getAttribute('data-token'), el.textContent, el.getAttribute('data-known')])

    it('colors the draft by token and marks commands missing from PATH as unknown', async () => {
      setMode('editor')
      idlePrompt()
      vi.mocked(window.ostia.pty.commands).mockResolvedValue(['git', 'grep'])
      renderEditor()
      await waitFor(() => expect(window.ostia.pty.commands).toHaveBeenCalled())
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'git log --oneline | nope "a" $HOME # c')
      await waitFor(() =>
        expect(tokens()).toEqual([
          ['command', 'git', 'true'],
          ['argument', 'log', null],
          ['flag', '--oneline', null],
          ['operator', '|', null],
          ['command', 'nope', 'false'],
          ['string', '"a"', null],
          ['variable', '$HOME', null],
          ['comment', '# c', null],
        ]),
      )
      expect(screen.getByTestId('input-editor-highlight').textContent).toBe(
        (editor() as HTMLTextAreaElement).value,
      )
    })

    it('shows the typed text itself while an IME composes', async () => {
      setMode('editor')
      idlePrompt()
      const { view } = renderEditor()
      await act(async () => {})
      const field = view.container.querySelector('.input-editor-field') as HTMLElement
      act(() => {
        editor()?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      })
      expect(field).toHaveAttribute('data-composing', 'true')
      act(() => {
        editor()?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      })
      expect(field).not.toHaveAttribute('data-composing')
    })
  })

  describe('vim mode', () => {
    function setVim(on: boolean): void {
      useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, inputEditorVim: on } }))
    }

    const mode = () => screen.queryByLabelText('Vim mode')?.textContent ?? null

    it('is off by default, so Escape still hands off to the shell line', async () => {
      setMode('editor')
      idlePrompt()
      const { props } = renderEditor()
      expect(mode()).toBeNull()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'ls')
      await user.keyboard('{Escape}')
      expect(props.onHandOff).toHaveBeenCalledWith('ls', '')
    })

    it('edits with motions, operators, counts and undo, then submits from normal mode', async () => {
      setMode('editor')
      setVim(true)
      idlePrompt()
      const { props } = renderEditor()
      const user = userEvent.setup()
      expect(mode()).toBe('INSERT')
      await user.type(editor() as HTMLElement, 'echo one two three')
      await user.keyboard('{Escape}')
      expect(mode()).toBe('NORMAL')
      expect(props.onHandOff).not.toHaveBeenCalled()
      await user.keyboard('0w')
      await user.keyboard('d')
      expect(mode()).toBe('NORMAL d')
      await user.keyboard('w')
      expect(editor()).toHaveValue('echo two three')
      await user.keyboard('2x')
      expect(editor()).toHaveValue('echo o three')
      await user.keyboard('u')
      expect(editor()).toHaveValue('echo two three')
      await user.keyboard('u')
      expect(editor()).toHaveValue('echo one two three')
      await user.keyboard('$cwfour')
      expect(mode()).toBe('INSERT')
      expect(editor()).toHaveValue('echo one two threfour')
      await user.keyboard('{Escape}0ea!')
      expect(editor()).toHaveValue('echo! one two threfour')
      await user.keyboard('{Escape}')
      await user.keyboard('{Enter}')
      expect(props.onSubmit).toHaveBeenCalledWith('echo! one two threfour')
      expect(mode()).toBe('INSERT')
    })

    it('ignores printable keys in normal mode and opens lines with o and O', async () => {
      setMode('editor')
      setVim(true)
      idlePrompt()
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'ls')
      await user.keyboard('{Escape}zq{Backspace}')
      expect(editor()).toHaveValue('ls')
      await user.keyboard('opwd{Escape}kOset -e{Escape}')
      expect(editor()).toHaveValue('set -e\nls\npwd')
      await user.keyboard('jdd')
      expect(editor()).toHaveValue('set -e\npwd')
    })

    it('walks history with k on the first line', async () => {
      setMode('editor')
      setVim(true)
      idlePrompt()
      runCommand('git status')
      finishCommand()
      renderEditor()
      const user = userEvent.setup()
      await user.type(editor() as HTMLElement, 'gi')
      await user.keyboard('{Escape}k')
      expect(editor()).toHaveValue('git status')
      await user.keyboard('j')
      expect(editor()).toHaveValue('gi')
    })
  })
})
