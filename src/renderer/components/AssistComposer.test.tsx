import type { AssistPoint, AssistRequests } from '@shared/assist'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { registerTerminal } from '../lib/terminalHandles'
import { useAssistComposerStore } from '../stores/assistComposerStore'
import { useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'

const agentState = vi.hoisted(() => ({
  agent: 'claude' as 'claude' | 'other' | null,
  insertable: true,
}))

vi.mock('../lib/sendPick', () => ({
  runningAgent: () => agentState.agent,
  canInsertReference: () => agentState.insertable,
}))

const { AssistComposer } = await import('./AssistComposer')
const { ASSIST_COMPOSE_COMMAND, startAssistCompose } = await import('../commands/assistCompose')

const PANE = 'pane-assist'
const PROVIDER = { extId: 'assistant', name: 'Assistant', label: 'model-runtime · gemma' }
const WAIT = { timeout: 5000 }

function fakeTerm(): Xterm & { paste: ReturnType<typeof vi.fn> } {
  return { focus: vi.fn(), paste: vi.fn() } as unknown as Xterm & {
    paste: ReturnType<typeof vi.fn>
  }
}

type Handler = (point: AssistPoint, input: AssistRequests[AssistPoint]) => Promise<unknown>

function answer(handler: Handler): void {
  vi.mocked(window.pine.assist.request).mockImplementation(((
    point: AssistPoint,
    _id: string,
    input: AssistRequests[AssistPoint],
  ) => handler(point, input)) as never)
}

function idlePrompt(): void {
  useBlocksStore.getState().promptStart(PANE, { line: 0 }, '/w')
  useBlocksStore.getState().promptEnd(PANE, { line: 0 })
}

function mount(term: Xterm) {
  const termRef = { current: term }
  act(() => useAssistComposerStore.getState().open(PANE))
  return render(<AssistComposer paneId={PANE} cwd="/home/u/proj" termRef={termRef} />)
}

describe('AssistComposer', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let unregister: () => void = () => {}

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
  })

  beforeEach(() => {
    agentState.agent = 'claude'
    agentState.insertable = true
    useAssistStore.setState({ availability: { input: PROVIDER, command: PROVIDER } })
  })

  afterEach(() => {
    unregister()
    useBlocksStore.setState(blocksInit, true)
    useAssistComposerStore.setState({ paneId: null })
    useAssistStore.setState({ availability: {} })
    vi.mocked(window.pine.assist.request).mockReset()
    vi.mocked(window.pine.assist.cancel).mockClear()
    vi.mocked(window.pine.pty.write).mockClear()
  })

  it('shows a typo fix as a hint and applies it only on Tab', async () => {
    const term = fakeTerm()
    unregister = registerTerminal(PANE, term)
    answer(async () => ({ ok: true, result: { corrected: 'fix the bug' } }))
    mount(term)
    const area = screen.getByRole('textbox', { name: 'Prompt for claude' })
    expect(screen.getByText('model-runtime · gemma')).toBeInTheDocument()
    await userEvent.type(area, 'fix teh bug')
    const hint = await screen.findByTestId('assist-typo-fix', {}, WAIT)
    expect(hint).toHaveTextContent('fix the bug')
    expect(area).toHaveValue('fix teh bug')
    await userEvent.keyboard('{Tab}')
    expect(area).toHaveValue('fix the bug')
    expect(screen.queryByTestId('assist-typo-fix')).toBeNull()
    expect(window.pine.assist.request).toHaveBeenCalledWith(
      'input',
      expect.any(String),
      expect.objectContaining({ text: 'fix teh bug', tasks: ['typos'], agent: 'claude' }),
    )
  })

  it('reviews the prompt on Ctrl+Enter and lists the notes', async () => {
    const term = fakeTerm()
    unregister = registerTerminal(PANE, term)
    answer(async (_point, input) =>
      (input as AssistRequests['input']).tasks.includes('review')
        ? { ok: true, result: { review: { score: 2, notes: ['Name the file to change'] } } }
        : { ok: true, result: {} },
    )
    mount(term)
    await userEvent.type(screen.getByRole('textbox'), 'make it faster')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    const review = await screen.findByTestId('assist-review', {}, WAIT)
    expect(review).toHaveTextContent('Clarity 2/5')
    expect(review).toHaveTextContent('Name the file to change')
  })

  it('pastes the prompt into the agent as text only, never with Enter', async () => {
    const term = fakeTerm()
    unregister = registerTerminal(PANE, term)
    answer(async () => ({ ok: true, result: {} }))
    mount(term)
    await userEvent.type(screen.getByRole('textbox'), 'refactor the parser')
    await userEvent.keyboard('{Enter}')
    expect(term.paste).toHaveBeenCalledWith('refactor the parser')
    expect(window.pine.pty.write).not.toHaveBeenCalled()
    expect(useAssistComposerStore.getState().paneId).toBeNull()
    expect(term.focus).toHaveBeenCalled()
  })

  it('copies instead of pasting when the agent cannot take input', async () => {
    const term = fakeTerm()
    unregister = registerTerminal(PANE, term)
    agentState.insertable = false
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    answer(async () => ({ ok: true, result: {} }))
    mount(term)
    await userEvent.type(screen.getByRole('textbox'), 'hello')
    await userEvent.keyboard('{Enter}')
    expect(term.paste).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(await screen.findByRole('status')).toHaveTextContent('clipboard')
  })

  it('cancels a pending request when the draft changes', async () => {
    const term = fakeTerm()
    unregister = registerTerminal(PANE, term)
    answer(() => new Promise(() => {}))
    mount(term)
    const area = screen.getByRole('textbox')
    await userEvent.type(area, 'first draft')
    await waitFor(() => expect(window.pine.assist.request).toHaveBeenCalledTimes(1), WAIT)
    const firstId = vi.mocked(window.pine.assist.request).mock.calls[0][1]
    await userEvent.type(area, ' more')
    expect(window.pine.assist.cancel).toHaveBeenCalledWith(firstId)
  })

  it('inserts a chosen command suggestion at an idle prompt without running it', async () => {
    agentState.agent = null
    idlePrompt()
    const term = fakeTerm()
    unregister = registerTerminal(PANE, term)
    answer(async (point) =>
      point === 'command'
        ? {
            ok: true,
            result: { suggestions: [{ command: 'du -sh * | sort -h', description: 'Sizes' }] },
          }
        : { ok: false, error: 'invalid' },
    )
    mount(term)
    const area = screen.getByRole('textbox', { name: 'Describe a command' })
    await userEvent.type(area, 'biggest folders here')
    expect(await screen.findByText('du -sh * | sort -h', {}, WAIT)).toBeInTheDocument()
    expect(window.pine.assist.request).toHaveBeenCalledWith(
      'command',
      expect.any(String),
      expect.objectContaining({ query: 'biggest folders here', cwd: '/home/u/proj' }),
    )
    await userEvent.keyboard('{Enter}')
    expect(term.paste).toHaveBeenCalledWith('du -sh * | sort -h')
    expect(window.pine.pty.write).not.toHaveBeenCalled()
    expect(useAssistComposerStore.getState().paneId).toBeNull()
  })

  it('offers the compose command only while an assist point is ready', () => {
    useAssistStore.setState({ availability: {} })
    const stop = startAssistCompose()
    expect(commands.has(ASSIST_COMPOSE_COMMAND)).toBe(false)
    act(() => useAssistStore.setState({ availability: { command: PROVIDER } }))
    expect(commands.has(ASSIST_COMPOSE_COMMAND)).toBe(true)
    act(() => useAssistStore.setState({ availability: {} }))
    expect(commands.has(ASSIST_COMPOSE_COMMAND)).toBe(false)
    stop()
  })
})
