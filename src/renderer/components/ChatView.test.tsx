import '@testing-library/jest-dom/vitest'
import type { AssistChunk } from '@shared/assist'
import type { ChatSessionSummary } from '@shared/chatSessions'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { firstPaneOfKind } from '../layout/tree'
import { useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import { resetChats, useChatStore } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ChatPane } from './ChatPane'
import { ChatView, hasVisibleContent } from './ChatView'
import { CommandPalette } from './CommandPalette'

vi.mock('../lib/colorize', () => ({ colorizeCode: async () => null }))

const PANE = 'p-chat-term'
const CHAT = { extId: 'assistant', name: 'Assistant', label: 'model-runtime · gemma' }

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
    vi.mocked(window.pine.chatSessions.list).mockResolvedValue([])
    vi.mocked(window.pine.chatSessions.save).mockImplementation(async (session) => ({
      ok: true,
      summary: { ...session, messageCount: session.messages.length },
      trimmedMessages: 0,
      evicted: [],
    }))
  })

  afterEach(() => {
    cleanup()
    resetChats()
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
      assistant: { chatHistory: true, mcpServers: [], skillFolders: [] },
    })
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.mocked(window.pine.assist.request).mockReset()
    vi.mocked(window.pine.assist.cancel).mockClear()
    vi.mocked(window.pine.chatSessions.save).mockReset()
    vi.mocked(window.pine.chatSessions.list).mockReset()
    vi.mocked(window.pine.chatSessions.rename).mockClear()
    vi.mocked(window.pine.chatSessions.remove).mockClear()
    vi.mocked(window.pine.chatSessions.exportMarkdown).mockClear()
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
    expect(window.pine.assist.request).not.toHaveBeenCalled()
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
    expect(window.pine.assist.cancel).toHaveBeenCalledWith(pending[0].requestId)
    await act(async () => pending[0].resolve({ ok: false, error: 'cancelled' }))

    await ask('again')
    await waitFor(() => expect(pending).toHaveLength(2))
    act(() => useUIStore.getState().closePalette())
    expect(window.pine.assist.cancel).toHaveBeenCalledWith(pending[1].requestId)
  })

  it('saves a finished turn with the model and context, and titles it from the question', async () => {
    const { pending, chunk } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('how do I list listening ports on linux quickly')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)

    await waitFor(() => expect(window.pine.chatSessions.save).toHaveBeenCalled())
    const session = vi.mocked(window.pine.chatSessions.save).mock.calls[0][0]
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
      assistant: { chatHistory: false, mcpServers: [], skillFolders: [] },
    })
    const { pending, chunk } = captureRequests()
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)

    await ask('hi')
    await waitFor(() => expect(pending).toHaveLength(1))
    await streamAnswer(pending, chunk)

    expect(await screen.findByText('Not saved')).toBeInTheDocument()
    expect(window.pine.chatSessions.save).not.toHaveBeenCalled()
  })

  it('keeps a chat started in a scratch workspace in memory only, even with history on', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: 'w1',
          name: 'scratch',
          customName: 'Scratch',
          kind: 'scratch',
          workDir: '/tmp/pine-scratch-1000/1-aaaaaaaaaaaa',
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
    expect(window.pine.chatSessions.save).not.toHaveBeenCalled()
    expect(window.pine.chatSessions.list).not.toHaveBeenCalled()
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
    useAssistStore.setState({ availability: { chat: { extId: 'assistant', name: 'Assistant' } } })
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
      vi.mocked(window.pine.chatSessions.list).mockResolvedValue(summaries)
      render(<ChatPane workspaceId="w1" paneId="p-chat" />)
      await userEvent.click(await screen.findByRole('button', { name: /Switch chat/ }))
      return screen.findByRole('list', { name: 'Chat sessions' })
    }

    it('searches, opens and starts sessions', async () => {
      vi.mocked(window.pine.chatSessions.get).mockResolvedValue({
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
      vi.mocked(window.pine.chatSessions.rename).mockResolvedValue(summaries[0])
      vi.mocked(window.pine.chatSessions.remove).mockResolvedValue(true)
      const list = await openList()
      const row = within(list).getByText('Deploy notes').closest('li') as HTMLElement

      await userEvent.click(within(row).getByRole('button', { name: 'Rename' }))
      const field = within(row).getByRole('textbox', { name: 'Chat title' })
      await userEvent.clear(field)
      await userEvent.type(field, 'Release checklist{Enter}')
      expect(window.pine.chatSessions.rename).toHaveBeenCalledWith('s-deploy', 'Release checklist')

      const fresh = within(list).getAllByRole('listitem')[0]
      await userEvent.click(within(fresh).getByRole('button', { name: 'Export as Markdown' }))
      expect(window.pine.chatSessions.exportMarkdown).toHaveBeenCalledWith('s-deploy')

      await userEvent.click(within(fresh).getByRole('button', { name: 'Delete' }))
      const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' })
      expect(window.pine.chatSessions.remove).not.toHaveBeenCalled()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      expect(window.pine.chatSessions.remove).toHaveBeenCalledWith('s-deploy')
    })
  })
})
