import '@testing-library/jest-dom/vitest'
import type { AssistChunk } from '@shared/assist'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { useAskStore } from '../stores/askStore'
import { useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { CommandPalette } from './CommandPalette'

const actions = vi.hoisted(() => ({
  canTypeInto: vi.fn(() => true),
  insertCommand: vi.fn(() => true),
  blockText: vi.fn(() => ''),
}))

vi.mock('../lib/blockActions', () => actions)

const PANE = 'p-ask'
const CHAT = { extId: 'assistant', name: 'Assistant', label: 'model-runtime · gemma' }

function seedWorkspace(): void {
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: 'w1',
        name: 'proj',
        kind: 'shell',
        workDir: '/home/u/proj',
        state: 'idle',
      } as never,
    ],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      w1: {
        root: { type: 'pane', id: PANE, title: 'zsh', kind: 'terminal', cwd: '/home/u/proj' },
        activePaneId: PANE,
        zoomedPaneId: null,
      },
    },
  })
}

function finishBlock(command: string, exitCode: number): string {
  const s = useBlocksStore.getState()
  s.promptStart(PANE, { line: 0 }, '/home/u/proj')
  s.promptEnd(PANE, { line: 0 })
  s.commandStart(PANE, { line: 1 }, command)
  s.commandEnd(PANE, { line: 3 }, exitCode)
  s.promptStart(PANE, { line: 3 }, '/home/u/proj')
  return useBlocksStore.getState().byPane[PANE]?.[0]?.id ?? ''
}

interface Pending {
  requestId: string
  input: unknown
  resolve: (value: unknown) => void
}

function captureRequests(): { pending: Pending[]; chunk: (text: string) => void } {
  const pending: Pending[] = []
  const listeners = new Set<(c: AssistChunk) => void>()
  vi.mocked(window.pine.assist.onChunk).mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  vi.mocked(window.pine.assist.request).mockImplementation(
    (_point, requestId, input) =>
      new Promise((resolve) => {
        pending.push({ requestId, input, resolve: resolve as (value: unknown) => void })
      }),
  )
  const chunk = (text: string): void => {
    const last = pending[pending.length - 1]
    for (const cb of listeners) cb({ requestId: last.requestId, text })
  }
  return { pending, chunk }
}

describe('CommandPalette Ask mode', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let askInit: ReturnType<typeof useAskStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
    blocksInit = useBlocksStore.getState()
    askInit = useAskStore.getState()
  })

  beforeEach(() => {
    seedWorkspace()
  })

  afterEach(() => {
    cleanup()
    useAskStore.getState().stopAll()
    useUIStore.setState(uiInit, true)
    useBlocksStore.setState(blocksInit, true)
    useAskStore.setState(askInit, true)
    useAssistStore.setState({ availability: {} })
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    actions.canTypeInto.mockReturnValue(true)
    actions.insertCommand.mockClear()
    vi.mocked(window.pine.assist.request).mockReset()
    vi.mocked(window.pine.assist.cancel).mockClear()
  })

  it('keeps Tab inert in the palette when no assistant serves chat', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    const input = await screen.findByRole('combobox')

    await userEvent.type(input, 'list files')
    await userEvent.keyboard('{Tab}')

    expect(screen.queryByRole('textbox', { name: 'Your question' })).toBeNull()
  })

  it('switches to Ask on Tab, carrying the typed text and naming the model', async () => {
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    const input = await screen.findByRole('combobox')

    await userEvent.type(input, 'find big files')
    await userEvent.keyboard('{Tab}')

    expect(await screen.findByRole('textbox', { name: 'Your question' })).toHaveValue(
      'find big files',
    )
    expect(screen.getByText(/Answers come from model-runtime · gemma/)).toBeInTheDocument()
  })

  it('streams chunks into the answer and renders the final markdown code block', async () => {
    const { pending, chunk } = captureRequests()
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await userEvent.type(await screen.findByRole('textbox', { name: 'Your question' }), 'big?')
    await userEvent.keyboard('{Enter}')
    expect(pending).toHaveLength(1)
    act(() => chunk('Use '))
    expect(await screen.findByText('Use')).toBeInTheDocument()
    act(() => chunk('find'))
    expect(await screen.findByText('Use find')).toBeInTheDocument()

    await act(async () =>
      pending[0].resolve({
        ok: true,
        result: { text: 'Use find:\n\n```bash\nfind . -size +100M\n```' },
      }),
    )

    const answer = await screen.findByLabelText('Answer')
    expect(within(answer).getByText('find . -size +100M')).toBeInTheDocument()
    expect(within(answer).getByRole('button', { name: /Insert at prompt/ })).toBeInTheDocument()
  })

  it('cancels the running request when Stop is pressed', async () => {
    const { pending } = captureRequests()
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await userEvent.type(await screen.findByRole('textbox', { name: 'Your question' }), 'hi')
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(window.pine.assist.cancel).toHaveBeenCalledWith(pending[0].requestId)
    await act(async () => pending[0].resolve({ ok: false, error: 'cancelled' }))
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
  })

  it('cancels a running request when the palette closes', async () => {
    const { pending } = captureRequests()
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await userEvent.type(await screen.findByRole('textbox', { name: 'Your question' }), 'hi')
    await userEvent.keyboard('{Enter}')
    act(() => useUIStore.getState().closePalette())

    expect(window.pine.assist.cancel).toHaveBeenCalledWith(pending[0].requestId)
  })

  it('inserts a shell block at the idle prompt without running it, then closes', async () => {
    const { pending } = captureRequests()
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your question' }), 'x')
    await userEvent.keyboard('{Enter}')
    await act(async () => pending[0].resolve({ ok: true, result: { text: '```sh\nls -la\n```' } }))

    await userEvent.click(await screen.findByRole('button', { name: /Insert at prompt/ }))

    expect(actions.insertCommand).toHaveBeenCalledWith(PANE, 'ls -la')
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })

  it('copies instead of typing when the pane is not at an idle prompt', async () => {
    const { pending } = captureRequests()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    actions.canTypeInto.mockReturnValue(false)
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your question' }), 'x')
    await userEvent.keyboard('{Enter}')
    await act(async () => pending[0].resolve({ ok: true, result: { text: '```sh\nls -la\n```' } }))

    await userEvent.click(await screen.findByRole('button', { name: /Insert at prompt/ }))

    expect(actions.insertCommand).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('ls -la')
    expect(await screen.findByText(/copied instead/)).toBeInTheDocument()
  })

  it('sends only the context chips the human turned on', async () => {
    const { pending } = captureRequests()
    finishBlock('npm test', 1)
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    const output = await screen.findByRole('button', { name: /Recent output/ })
    expect(output).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Folder/ })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(output)
    await userEvent.type(screen.getByRole('textbox', { name: 'Your question' }), 'why?')
    await userEvent.keyboard('{Enter}')

    const input = pending[0].input as { context: { kind: string; text: string }[] }
    expect(input.context.map((c) => c.kind)).toEqual(['cwd', 'output'])
    expect(input.context[0].text).toBe('/home/u/proj')
    expect(screen.getByText('Sent with Folder, Recent output')).toBeInTheDocument()
  })

  it('shows the assistant error with its message', async () => {
    const { pending } = captureRequests()
    useAssistStore.setState({ availability: { chat: CHAT } })
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your question' }), 'x')
    await userEvent.keyboard('{Enter}')

    await act(async () => pending[0].resolve({ ok: false, error: 'rate-limited' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many requests/)
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
  })
})
