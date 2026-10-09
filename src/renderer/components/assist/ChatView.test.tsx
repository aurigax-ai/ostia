import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { CommandPalette } from '@/components/CommandPalette'
import { firstPaneOfKind } from '@/layout/tree'
import { useAssistStore } from '@/stores/assistStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { resetChats, useChatStore } from '@/stores/chatStore'
import { resetChatTools, useChatToolsStore } from '@/stores/chatToolsStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useLiveSelectionStore } from '@/stores/liveSelectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { AssistChunk } from '@shared/assist'
import type { ChatSessionSummary } from '@shared/assist/chatSessions'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { ChatPane } from './ChatPane'
import { ChatView, REDACTION_PREVIEW_MS, hasVisibleContent } from './ChatView'

vi.mock('@/lib/theme/colorize', () => ({ colorizeCode: async () => null }))

const PANE = 'p-chat-term'
const CHAT = {
  extId: 'assistant',
  name: 'Assistant',
  label: 'model-runtime · gemma',
  ref: { extId: 'assistant' },
}

function seedWorkspace(): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'proj', kind: 'terminal', workDir: '/home/u/proj', state: 'idle' } as never,
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

function idlePrompt(): void {
  const s = useBlocksStore.getState()
  s.promptStart(PANE, { line: 0 }, '/home/u/proj')
  s.promptEnd(PANE, { line: 0 })
}

interface Pending {
  requestId: string
  input: unknown
  resolve: (value: unknown) => void
}

function captureRequests(): { pending: Pending[]; chunk: (chunk: object | string) => void } {
  const pending: Pending[] = []
  const listeners = new Set<(c: AssistChunk) => void>()
  vi.mocked(window.ostia.assist.onChunk).mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  vi.mocked(window.ostia.assist.request).mockImplementation(
    (_point, requestId, input) =>
      new Promise((resolve) => {
        pending.push({ requestId, input, resolve: resolve as (value: unknown) => void })
      }),
  )
  const chunk = (value: object | string): void => {
    const last = pending[pending.length - 1]
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    for (const cb of listeners) cb({ requestId: last.requestId, text })
  }
  return { pending, chunk }
}

const ANSWER = 'Use find:\n\n```bash\nfind . -size +100M\n```'

async function streamAnswer(
  pending: Pending[],
  chunk: (value: object) => void,
  text = ANSWER,
): Promise<void> {
  act(() => {
    chunk({ type: 'start' })
    chunk({ type: 'text-start', id: 't' })
    chunk({ type: 'text-delta', id: 't', delta: text })
    chunk({ type: 'text-end', id: 't' })
    chunk({ type: 'finish' })
  })
  await act(async () => pending[pending.length - 1].resolve({ ok: true, result: { text } }))
}

async function ask(question: string): Promise<void> {
  await userEvent.type(await screen.findByRole('combobox', { name: 'Your question' }), question)
  await userEvent.keyboard('{Enter}')
}

describe('hasVisibleContent', () => {
  const message = (parts: object[]) => ({ id: 'a', role: 'assistant' as const, parts }) as never

  it('is false with no message, no parts, or only blank text and step markers', () => {
    expect(hasVisibleContent(undefined)).toBe(false)
    expect(hasVisibleContent(message([]))).toBe(false)
    expect(
      hasVisibleContent(message([{ type: 'step-start' }, { type: 'text', text: '  \n' }])),
    ).toBe(false)
    expect(hasVisibleContent(message([{ type: 'reasoning', text: 'thinking' }]))).toBe(false)
  })

  it('is true once there is text or a tool part', () => {
    expect(hasVisibleContent(message([{ type: 'text', text: 'Hi' }]))).toBe(true)
    expect(
      hasVisibleContent(
        message([
          {
            type: 'dynamic-tool',
            toolName: 'read_file',
            toolCallId: 't1',
            state: 'input-streaming',
          },
        ]),
      ),
    ).toBe(true)
    expect(
      hasVisibleContent(
        message([{ type: 'tool-read_file', toolCallId: 't1', state: 'input-available' }]),
      ),
    ).toBe(true)
  })
})

describe('chat', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
    blocksInit = useBlocksStore.getState()
  })

  beforeEach(() => {
    seedWorkspace()
    useAssistStore.setState({ availability: { chat: CHAT } })
    vi.mocked(window.ostia.chatSessions.list).mockResolvedValue([])
    vi.mocked(window.ostia.chatSessions.save).mockImplementation(async (session) => ({
      ok: true,
      summary: { ...session, messageCount: session.messages.length },
      trimmedMessages: 0,
      evicted: [],
    }))
  })

  afterEach(() => {
    cleanup()
    resetChats()
    resetChatTools()
    vi.mocked(window.ostia.chatSessions.get).mockReset()
    vi.mocked(window.ostia.chatTools.restore).mockReset()
    useLiveSelectionStore.setState({ byWorkspace: {} })
    useChatStore.setState({
      current: {},
      meta: {},
      summaries: [],
      notice: {},
      drafts: {},
      attachments: {},
    })
    useUIStore.setState(uiInit, true)
    useBlocksStore.setState(blocksInit, true)
    useAssistStore.setState({ availability: {} })
    useSettingsStore.setState({
      assistant: {
        chatHistory: true,
        mcpServers: [],
        skillFolders: [],
        providers: [],
        fastModel: null,
        chatModel: null,
      },
    })
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.mocked(window.ostia.privacy.redact).mockImplementation(async (texts) =>
      texts.map((text) => ({ text, count: 0, kinds: {} })),
    )
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.assist.cancel).mockClear()
    vi.mocked(window.ostia.chatSessions.save).mockReset()
    vi.mocked(window.ostia.chatSessions.list).mockReset()
    vi.mocked(window.ostia.chatSessions.rename).mockClear()
    vi.mocked(window.ostia.chatSessions.remove).mockClear()
    vi.mocked(window.ostia.chatSessions.exportMarkdown).mockClear()
  })

  it('carries only the typed text to Ask when the palette was opened on the commands prefix', async () => {
    render(<CommandPalette />)
    act(() => useUIStore.getState().togglePalette())
    const input = await screen.findByRole('combobox')
    expect(input).toHaveValue('>')
    await userEvent.type(input, 'find big files')
    await userEvent.keyboard('{Tab}')

    expect(await screen.findByRole('combobox', { name: 'Your question' })).toHaveValue(
      'find big files',
    )
  })

  it('switches the palette to Ask on Tab, carrying the typed text and naming the model', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    await userEvent.type(await screen.findByRole('combobox'), 'find big files')
    await userEvent.keyboard('{Tab}')

    expect(await screen.findByRole('combobox', { name: 'Your question' })).toHaveValue(
      'find big files',
    )
    expect(screen.getByText(/Answers come from model-runtime · gemma/)).toBeInTheDocument()
  })

  it('takes focus back into the question box when the dialog grabs it as Ask opens', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    let popup: HTMLDivElement | null = null
    render(
      <div
        ref={(el) => {
          popup = el
        }}
        tabIndex={-1}
      >
        <ChatView workspaceId="w1" variant="palette" seed="list files" />
      </div>,
    )
    const box = await screen.findByRole('combobox', { name: 'Your question' })
    act(() => popup?.focus())
    expect(box).not.toHaveFocus()
    act(() => {
      for (const frame of frames.splice(0)) frame(0)
    })
    expect(box).toHaveFocus()
    raf.mockRestore()
  })

  it('keeps Send enabled on an empty draft and sends nothing when clicked', async () => {
    render(<ChatView workspaceId="w1" variant="pane" />)
    const send = await screen.findByRole('button', { name: 'Send' })
    expect(send).toBeEnabled()
    await userEvent.click(send)
    expect(window.ostia.assist.request).not.toHaveBeenCalled()
  })

  it('streams UI message chunks into a markdown answer with a code block', async () => {
    const { pending, chunk } = captureRequests()
    idlePrompt()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('big files?')
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].input).toMatchObject({
      messages: [{ role: 'user', content: 'big files?' }],
      context: [{ kind: 'cwd', text: '/home/u/proj' }],
    })
    act(() => {
      chunk({ type: 'start' })
      chunk({ type: 'text-start', id: 't' })
      chunk({ type: 'text-delta', id: 't', delta: 'Use ' })
    })
    expect(await screen.findByText('Use')).toBeInTheDocument()
    await streamAnswer(pending, chunk, 'find:\n\n```bash\nfind . -size +100M\n```')

    const answer = await screen.findByLabelText('Answer')
    expect(within(answer).getByText('find . -size +100M')).toBeInTheDocument()
    const insert = within(answer).getByRole('button', { name: /Insert at prompt/ })
    expect(insert).not.toHaveAttribute('aria-disabled', 'true')
    expect(within(answer).getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(within(answer).getByRole('button', { name: 'Copy as Markdown' })).toBeInTheDocument()
  })

  it('sends the text selected in the workspace with the next question by itself', async () => {
    const { pending } = captureRequests()
    idlePrompt()
    useLiveSelectionStore
      .getState()
      .report(
        'w1',
        'p-editor',
        { kind: 'editor', file: '/home/u/proj/src/a.ts', startLine: 2, endLine: 4 },
        'two\nthree',
      )
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    const chip = await screen.findByRole('button', { name: /Selection/ })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(chip).toHaveTextContent('a.ts:2-4')
    await ask('what is this?')
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].input).toMatchObject({
      context: expect.arrayContaining([
        {
          kind: 'selection',
          label: 'Selection a.ts:2-4',
          text: 'two\nthree',
          path: '/home/u/proj/src/a.ts',
          startLine: 2,
          endLine: 4,
        },
      ]),
    })
  })

  it('shows how many secrets will be redacted, sends the redacted text and says so on the sent message', async () => {
    vi.mocked(window.ostia.privacy.redact).mockImplementation(async (texts) =>
      texts.map((text) => {
        const count = text.split('SECRET').length - 1
        return { text: text.replaceAll('SECRET', '[redacted:test]'), count, kinds: {} }
      }),
    )
    const { pending } = captureRequests()
    idlePrompt()
    useLiveSelectionStore
      .getState()
      .report(
        'w1',
        'p-editor',
        { kind: 'editor', file: '/home/u/proj/.env', startLine: 1, endLine: 1 },
        'API_KEY=SECRET',
      )
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await renderSettled(<CommandPalette />)

      await act(() => vi.advanceTimersByTimeAsync(REDACTION_PREVIEW_MS))
      expect(screen.getByTestId('chat-redaction-count')).toHaveTextContent(
        '1 secret will be redacted',
      )
      const box = screen.getByRole('combobox', { name: 'Your question' })
      fireEvent.change(box, { target: { value: 'why is SECRET refused?' } })
      await act(() => vi.advanceTimersByTimeAsync(REDACTION_PREVIEW_MS))
      expect(screen.getByTestId('chat-redaction-count')).toHaveTextContent(
        '2 secrets will be redacted',
      )
      fireEvent.keyDown(box, { key: 'Enter' })
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(pending).toHaveLength(1)
      const sent = pending[0].input as {
        messages: { content: string }[]
        context: { text: string }[]
      }
      expect(sent.messages[0].content).toBe('why is [redacted:test] refused?')
      expect(sent.context.map((c) => c.text)).toContain('API_KEY=[redacted:test]')
      expect(JSON.stringify(sent)).not.toContain('SECRET')
      const question = screen.getByLabelText('Your question', { selector: '.chat-message' })
      expect(question).toHaveTextContent('why is [redacted:test] refused?')
      expect(question).toHaveTextContent('2 secrets redacted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows no redaction note when nothing would be redacted', async () => {
    captureRequests()
    idlePrompt()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)
    await userEvent.type(
      await screen.findByRole('combobox', { name: 'Your question' }),
      'what is in this folder?',
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(screen.queryByTestId('chat-redaction-count')).toBeNull()
  })

  it('leaves the selection out once the human switches its chip off', async () => {
    const { pending } = captureRequests()
    idlePrompt()
    useLiveSelectionStore.getState().report('w1', PANE, { kind: 'terminal' }, 'ls -la')
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    const chip = await screen.findByRole('button', { name: /Selection/ })
    await userEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await ask('and this?')
    await waitFor(() => expect(pending).toHaveLength(1))
    const { context } = pending[0].input as { context: { kind: string }[] }
    expect(context.some((item) => item.kind === 'selection')).toBe(false)
  })

  it('disables Insert at prompt with the reason while the terminal runs a command', async () => {
    const { pending, chunk } = captureRequests()
    idlePrompt()
    useBlocksStore.getState().commandStart(PANE, { line: 1 }, 'sleep 100')
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)

    const insert = await screen.findByRole('button', { name: /Insert at prompt/ })
    expect(insert).toHaveAttribute('aria-disabled', 'true')
    expect(insert).toHaveAccessibleDescription(/not at an idle prompt/)
  })

  it('cancels the running request on Stop and when the palette closes', async () => {
    const { pending } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(window.ostia.assist.cancel).toHaveBeenCalledWith(pending[0].requestId)
    await act(async () => pending[0].resolve({ ok: false, error: 'cancelled' }))

    await ask('again')
    await waitFor(() => expect(pending).toHaveLength(2))
    act(() => useUIStore.getState().closePalette())
    expect(window.ostia.assist.cancel).toHaveBeenCalledWith(pending[1].requestId)
  })

  it('saves a finished turn with the model and context, and titles it from the question', async () => {
    const { pending, chunk } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('how do I list listening ports on linux quickly')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)

    await waitFor(() => expect(window.ostia.chatSessions.save).toHaveBeenCalled())
    const session = vi.mocked(window.ostia.chatSessions.save).mock.calls[0][0]
    expect(session).toMatchObject({
      workspaceId: 'w1',
      title: 'how do I list listening ports on linux quickly',
      model: 'model-runtime · gemma',
    })
    expect(session.messages[0]).toMatchObject({
      role: 'user',
      metadata: { context: [{ kind: 'cwd' }] },
    })
    expect(session.messages[1].parts).toContainEqual({ type: 'text', text: ANSWER, state: 'done' })
  })

  it('keeps the chat in memory only while chat history is off', async () => {
    useSettingsStore.setState({
      assistant: {
        chatHistory: false,
        mcpServers: [],
        skillFolders: [],
        providers: [],
        fastModel: null,
        chatModel: null,
      },
    })
    const { pending, chunk } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)

    expect(await screen.findByText('Not saved')).toBeInTheDocument()
    expect(window.ostia.chatSessions.save).not.toHaveBeenCalled()
  })

  it('keeps a chat started in a scratch workspace in memory only, even with history on', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 'w1',
          name: 'scratch',
          customName: 'Scratch',
          kind: 'scratch',
          workDir: '/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa',
          state: 'idle',
        },
      ],
    })
    const { pending, chunk } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)

    expect(await screen.findByText('Not saved')).toBeInTheDocument()
    expect(window.ostia.chatSessions.save).not.toHaveBeenCalled()
    expect(window.ostia.chatSessions.list).not.toHaveBeenCalled()
  })

  it('opens the palette conversation in a chat pane that shows the same session', async () => {
    const { pending, chunk } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    const { rerender } = render(<CommandPalette />)

    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)
    await userEvent.click(screen.getByRole('button', { name: 'Open in pane' }))

    expect(useUIStore.getState().paletteOpen).toBe(false)
    const root = useLayoutStore.getState().byWorkspace.w1?.root
    const pane = root ? firstPaneOfKind(root, 'chat') : null
    expect(pane).not.toBeNull()
    rerender(<ChatPane workspaceId="w1" paneId={pane?.id ?? ''} />)
    expect(await screen.findByText('find . -size +100M')).toBeInTheDocument()
    await waitFor(() =>
      expect(firstPaneOfKind(useLayoutStore.getState().byWorkspace.w1.root, 'chat')).toMatchObject({
        title: 'hi',
        chatSessionId: useChatStore.getState().current.w1,
      }),
    )
  })

  it('reopens a saved chat with Undo on its edits and a checkpoint on the question before them', async () => {
    vi.mocked(window.ostia.chatSessions.list).mockResolvedValue([
      {
        id: 's-edit',
        workspaceId: 'w1',
        title: 'Edit',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 2,
      },
    ])
    vi.mocked(window.ostia.chatSessions.get).mockResolvedValue({
      id: 's-edit',
      workspaceId: 'w1',
      title: 'Edit',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 2,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'rename it' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'edit_file',
              toolCallId: 'e1',
              state: 'output-available',
              input: { path: 'a.ts' },
              output: { path: '/home/u/proj/a.ts', created: false, added: 1, removed: 1 },
            },
          ],
        },
      ],
      edits: [
        {
          toolCallId: 'e1',
          path: '/home/u/proj/a.ts',
          root: '/home/u/proj',
          existed: true,
          outside: false,
          symlink: false,
          auto: false,
          state: 'applied',
          version: 'v-new',
          seq: 1,
          decisions: ['accepted'],
          before: 'old\n',
          after: 'new\n',
        },
      ],
    })
    vi.mocked(window.ostia.chatTools.restore).mockResolvedValue({
      ok: true,
      path: '/home/u/proj/a.ts',
      removed: false,
      version: 'v-old',
    })
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    const card = await screen.findByRole('region', { name: 'Edit to a.ts' })
    expect(within(card).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Edits to review' })).toBeNull()
    await userEvent.click(
      screen.getByRole('button', { name: 'Restore files to before this message' }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore files to before this message?',
    })
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Restore files (1)' }))
    await waitFor(() => expect(useChatToolsStore.getState().edits.e1.state).toBe('undone'))
    expect(
      screen.queryByRole('button', { name: 'Restore files to before this message' }),
    ).toBeNull()
    expect(await screen.findByText('Files restored: 1.')).toBeInTheDocument()
    await waitFor(() => expect(window.ostia.chatSessions.save).toHaveBeenCalled())
    const saved = vi.mocked(window.ostia.chatSessions.save).mock.calls.at(-1)?.[0]
    expect(saved?.edits?.[0]).toMatchObject({ toolCallId: 'e1', state: 'undone', version: 'v-old' })
  })

  it('names the model and counts seconds until the answer shows text', async () => {
    const { pending, chunk } = captureRequests()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      render(<ChatPane workspaceId="w1" paneId="p-chat" />)
      await ask('hi')
      await waitFor(() => expect(pending).toHaveLength(1))

      expect(screen.getByText('Waiting for model-runtime · gemma… 0s')).toBeInTheDocument()
      act(() => {
        chunk({ type: 'start' })
        chunk({ type: 'text-start', id: 't' })
      })
      act(() => vi.advanceTimersByTime(2000))
      expect(screen.getByText('Waiting for model-runtime · gemma… 2s')).toBeInTheDocument()

      act(() => chunk({ type: 'text-delta', id: 't', delta: 'Hello' }))
      expect(await screen.findByText('Hello')).toBeInTheDocument()
      expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('names the provider while waiting when it reports no model label', async () => {
    useAssistStore.setState({
      availability: {
        chat: { extId: 'assistant', name: 'Assistant', ref: { extId: 'assistant' } },
      },
    })
    const { pending } = captureRequests()
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(screen.getByText('Waiting for Assistant… 0s')).toBeInTheDocument()
  })

  describe('session list', () => {
    const summaries: ChatSessionSummary[] = [
      {
        id: 's-deploy',
        workspaceId: 'w1',
        title: 'Deploy notes',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 4,
      },
      {
        id: 's-ports',
        workspaceId: 'w2',
        title: 'Ports on linux',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 2,
      },
    ]

    const openList = async (): Promise<HTMLElement> => {
      vi.mocked(window.ostia.chatSessions.list).mockResolvedValue(summaries)
      render(<ChatPane workspaceId="w1" paneId="p-chat" />)
      await userEvent.click(await screen.findByRole('button', { name: /Switch chat/ }))
      return screen.findByRole('list', { name: 'Chat sessions' })
    }

    it('searches, opens and starts sessions', async () => {
      vi.mocked(window.ostia.chatSessions.get).mockResolvedValue({
        ...summaries[1],
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'which ports?' }] }],
      })
      const list = await openList()
      expect(within(list).getAllByRole('listitem')).toHaveLength(2)

      await userEvent.type(screen.getByRole('textbox', { name: 'Search chats' }), 'ports')
      expect(within(list).getAllByRole('listitem')).toHaveLength(1)
      await userEvent.click(within(list).getByText('Ports on linux'))

      expect(await screen.findByText('which ports?')).toBeInTheDocument()
      expect(useChatStore.getState().current.w1).toBe('s-ports')
    })

    it('renames, exports and deletes after a confirm', async () => {
      vi.mocked(window.ostia.chatSessions.rename).mockResolvedValue(summaries[0])
      vi.mocked(window.ostia.chatSessions.remove).mockResolvedValue(true)
      const list = await openList()
      const row = within(list).getByText('Deploy notes').closest('li') as HTMLElement

      await userEvent.click(within(row).getByRole('button', { name: 'Rename' }))
      const field = within(row).getByRole('textbox', { name: 'Chat title' })
      await userEvent.clear(field)
      await userEvent.type(field, 'Release checklist{Enter}')
      expect(window.ostia.chatSessions.rename).toHaveBeenCalledWith('s-deploy', 'Release checklist')

      const fresh = within(list).getAllByRole('listitem')[0]
      await userEvent.click(within(fresh).getByRole('button', { name: 'Export as Markdown' }))
      expect(window.ostia.chatSessions.exportMarkdown).toHaveBeenCalledWith('s-deploy')

      await userEvent.click(within(fresh).getByRole('button', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' })
      expect(window.ostia.chatSessions.remove).not.toHaveBeenCalled()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      expect(window.ostia.chatSessions.remove).toHaveBeenCalledWith('s-deploy')
    })
  })
})
