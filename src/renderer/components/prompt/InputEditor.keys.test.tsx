import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { idlePrompt } from '../../../../test/idlePrompt'
import { InputEditor, type InputEditorProps } from './InputEditor'

const PANE = 'pane-keys'
const ARM = 'Press Esc again to clear'
const CLEARED = 'Draft cleared · Ctrl+Z to restore'
const FILE_HINT = 'Tab to complete · Enter runs'

function fakeTerm(): Xterm {
  return {
    focus: vi.fn(),
    getSelection: () => '',
    hasSelection: () => false,
    clearSelection: vi.fn(),
    scrollToBottom: vi.fn(),
  } as unknown as Xterm
}

function setBehavior(patch: Partial<ReturnType<typeof useSettingsStore.getState>['behavior']>) {
  useSettingsStore.setState((s) => ({ behavior: { ...s.behavior, ...patch } }))
}

function renderEditor() {
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
  }
  render(<InputEditor {...props} />)
  return props
}

const editor = () => screen.getByRole('textbox', { name: 'Command input' })
const options = () => screen.queryAllByRole('option').map((o) => o.textContent)

describe('InputEditor Esc', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    blocksInit = useBlocksStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useBlocksStore.setState(blocksInit, true)
  })

  function ready(): void {
    setBehavior({ inputMode: 'editor' })
    idlePrompt(PANE, '/w')
  }

  it('asks for a second Esc, clears the draft on it and restores it once with Ctrl+Z', async () => {
    ready()
    const props = renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'git commit -m wip')
    await user.keyboard('{Escape}')
    expect(editor()).toHaveValue('git commit -m wip')
    expect(screen.getByText(ARM)).toBeVisible()
    await user.keyboard('{Escape}')
    expect(editor()).toHaveValue('')
    expect(screen.getByText(CLEARED)).toBeVisible()
    await user.keyboard('{Control>}z{/Control}')
    expect(editor()).toHaveValue('git commit -m wip')
    expect(screen.queryByText(CLEARED)).toBeNull()
    await user.keyboard('{Control>}z{/Control}')
    expect(editor()).toHaveValue('git commit -m wip')
    expect(props.onHandOff).not.toHaveBeenCalled()
  })

  it('forgets the restore once the human types again', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls')
    await user.keyboard('{Escape}{Escape}')
    await user.keyboard('x')
    expect(screen.queryByText(CLEARED)).toBeNull()
    await user.keyboard('{Control>}z{/Control}')
    expect(editor()).toHaveValue('x')
  })

  it('ends the tip after the window so the next Esc asks again', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByText(ARM)).toBeNull(), { timeout: 2500 })
    await user.keyboard('{Escape}')
    expect(editor()).toHaveValue('ls')
    expect(screen.getByText(ARM)).toBeVisible()
  })

  it('does nothing on an empty draft', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.click(editor())
    await user.keyboard('{Escape}{Escape}')
    expect(screen.queryByText(ARM)).toBeNull()
    expect(screen.queryByText(CLEARED)).toBeNull()
  })

  it('keeps the draft on every Esc when the setting only closes menus', async () => {
    ready()
    setBehavior({ inputEscape: 'menus' })
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls')
    await user.keyboard('{Escape}{Escape}{Escape}')
    expect(editor()).toHaveValue('ls')
    expect(screen.queryByText(ARM)).toBeNull()
  })

  it('never clears in vim mode', async () => {
    ready()
    setBehavior({ inputEditorVim: true })
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls')
    await user.keyboard('{Escape}{Escape}')
    expect(editor()).toHaveValue('ls')
    expect(screen.queryByText(ARM)).toBeNull()
  })

  it('spends the first Esc on an open menu', async () => {
    ready()
    vi.mocked(window.ostia.pty.commands).mockResolvedValue(['git', 'gist'])
    renderEditor()
    await waitFor(() => expect(window.ostia.pty.commands).toHaveBeenCalled())
    const user = userEvent.setup()
    await user.type(editor(), 'gi')
    await user.keyboard('{Tab}')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByText(ARM)).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.getByText(ARM)).toBeVisible()
  })
})

describe('InputEditor file suggestions while typing', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    blocksInit = useBlocksStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useBlocksStore.setState(blocksInit, true)
    vi.mocked(window.ostia.pty.listDir).mockReset()
  })

  function ready(): void {
    setBehavior({ inputMode: 'editor' })
    idlePrompt(PANE, '/w')
    vi.mocked(window.ostia.pty.listDir).mockImplementation(async (_pane, path) =>
      path === '/home/u/proj/src'
        ? [
            { name: 'main.ts', dir: false },
            { name: 'menu.md', dir: false },
            { name: 'util.ts', dir: false },
          ]
        : [],
    )
  }

  it('opens by itself on a path, filters as the human types and shows the hint', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/')
    await screen.findByRole('listbox')
    expect(options()).toEqual(['main.ts', 'menu.md', 'util.ts'])
    expect(screen.getByText(FILE_HINT)).toBeVisible()
    await user.keyboard('ut')
    expect(options()).toEqual(['util.ts'])
  })

  it('stays closed for a plain word', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src')
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(window.ostia.pty.listDir).not.toHaveBeenCalled()
  })

  it('stays closed when the setting is off', async () => {
    ready()
    setBehavior({ liveFileSuggestions: false })
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/')
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(window.ostia.pty.listDir).not.toHaveBeenCalled()
  })

  it('takes the selected entry on Tab and moves with the arrows', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/m')
    await screen.findByRole('listbox')
    await user.keyboard('{ArrowDown}{Tab}')
    expect(editor()).toHaveValue('ls src/menu.md ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('takes the selected entry on the right arrow', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/u')
    await screen.findByRole('listbox')
    await user.keyboard('{ArrowRight}')
    expect(editor()).toHaveValue('ls src/util.ts ')
  })

  it('always runs the line on Enter and never picks', async () => {
    ready()
    const props = renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/m')
    await screen.findByRole('listbox')
    await user.keyboard('{Enter}')
    expect(props.onSubmit).toHaveBeenCalledWith('ls src/m')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Esc without touching the draft and does not arm the clear tip', async () => {
    ready()
    renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/m')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(editor()).toHaveValue('ls src/m')
    expect(screen.queryByText(ARM)).toBeNull()
  })

  it('keeps Enter picking in a menu the human opened with Tab', async () => {
    ready()
    setBehavior({ liveFileSuggestions: false })
    const props = renderEditor()
    const user = userEvent.setup()
    await user.type(editor(), 'ls src/m')
    await user.keyboard('{Tab}')
    await screen.findByRole('listbox')
    expect(screen.queryByText(FILE_HINT)).toBeNull()
    await user.keyboard('{Enter}')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })
})
