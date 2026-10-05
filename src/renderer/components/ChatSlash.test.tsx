import '@testing-library/jest-dom/vitest'
import type { AssistChunk } from '@shared/assist'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { useAssistStore } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import { resetChats, useChatStore } from '../stores/chatStore'
import { resetChatTools } from '../stores/chatToolsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ChatPane } from './ChatPane'
import { CommandPalette } from './CommandPalette'

vi.mock('../lib/colorize', () => ({ colorizeCode: async () => null }))

const PANE = 'p-slash-term'
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

interface Pending {
  requestId: string
  input: unknown
  resolve: (value: unknown) => void
}

function captureRequests(): { pending: Pending[]; chunk: (chunk: object) => void } {
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
  const chunk = (value: object): void => {
    const last = pending[pending.length - 1]
    for (const cb of listeners) cb({ requestId: last.requestId, text: JSON.stringify(value) })
  }
  return { pending, chunk }
}

async function answer(pending: Pending[], chunk: (value: object) => void, text: string) {
  act(() => {
    chunk({ type: 'start' })
    chunk({ type: 'text-start', id: 't' })
    chunk({ type: 'text-delta', id: 't', delta: text })
    chunk({ type: 'text-end', id: 't' })
    chunk({ type: 'finish' })
  })
  await act(async () => pending[pending.length - 1].resolve({ ok: true, result: { text } }))
}

function question(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Your question' })
}

async function openPane(): Promise<HTMLElement> {
  render(<ChatPane workspaceId="w1" paneId="p-chat" />)
  const box = await screen.findByRole('combobox', { name: 'Your question' })
  await userEvent.click(box)
  return box
}

function options(): string[] {
  return within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
}

describe('chat slash commands', () => {
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
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.chatSessions.save).mockReset()
    vi.mocked(window.ostia.chatSessions.list).mockReset()
    vi.mocked(window.ostia.chatSessions.rename).mockClear()
    vi.mocked(window.ostia.chatSessions.remove).mockClear()
    vi.mocked(window.ostia.chatTools.skills).mockResolvedValue([])
  })

  it('opens a command list on "/" that filters as you type and points the box at the active option', async () => {
    const box = await openPane()
    expect(box).toHaveAttribute('aria-expanded', 'false')
    await userEvent.type(box, '/')

    const list = screen.getByRole('listbox', { name: 'Chat commands' })
    expect(within(list).getAllByRole('option')).toHaveLength(12)
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveAttribute('aria-controls', list.id)
    const first = within(list).getAllByRole('option')[0]
    expect(first).toHaveTextContent('/new')
    expect(box).toHaveAttribute('aria-activedescendant', first.id)

    await userEvent.type(box, 're')
    expect(options()).toEqual([
      expect.stringContaining('/rename'),
      expect.stringContaining('/retry'),
    ])
    await userEvent.keyboard('{ArrowDown}')
    const retry = screen.getByRole('option', { name: /\/retry/ })
    expect(box).toHaveAttribute('aria-activedescendant', retry.id)
  })

  it('opens the menu after leading whitespace but not in the middle of a question', async () => {
    const box = await openPane()
    await userEvent.type(box, 'what is ')
    await userEvent.type(box, '/')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await userEvent.clear(box)
    await userEvent.type(box, '  /he')
    expect(options()).toEqual([expect.stringContaining('/help')])
  })

  it('runs the picked command locally with the keyboard and never sends it to the model', async () => {
    const { pending } = captureRequests()
    const box = await openPane()
    await userEvent.type(box, '/he')
    await userEvent.keyboard('{Enter}')

    const help = await screen.findByRole('region', { name: 'Chat commands' })
    expect(within(help).getByText('/skill')).toBeInTheDocument()
    expect(box).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(pending).toHaveLength(0)
    await userEvent.click(within(help).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('region', { name: 'Chat commands' })).not.toBeInTheDocument()
  })

  it('runs a command picked with the mouse', async () => {
    const box = await openPane()
    await userEvent.type(box, '/')
    await userEvent.click(screen.getByRole('option', { name: /\/model/ }))
    expect(await screen.findByRole('menuitem', { name: 'Manage models…' })).toBeInTheDocument()
    expect(box).toHaveValue('')
  })

  it('closes the menu on Escape without closing the palette', async () => {
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)
    const box = await screen.findByRole('combobox', { name: 'Your question' })
    await userEvent.type(box, '/')
    expect(screen.getByRole('listbox', { name: 'Chat commands' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Chat commands' })).not.toBeInTheDocument()
    expect(useUIStore.getState().paletteOpen).toBe(true)
    expect(question()).toHaveValue('/')
  })

  it('greys out unavailable commands with the reason, and refuses to run them', async () => {
    const { pending } = captureRequests()
    const box = await openPane()
    await userEvent.type(box, '/')

    const retry = screen.getByRole('option', { name: /\/retry/ })
    expect(retry).toHaveAttribute('aria-disabled', 'true')
    expect(retry).toHaveTextContent('There is no answer to retry yet.')
    expect(screen.getByRole('option', { name: /\/tools/ })).toHaveTextContent(
      'This model does not use tools.',
    )
    expect(screen.getByRole('option', { name: /\/clear/ })).toHaveTextContent(
      'This chat has no messages yet.',
    )

    await userEvent.type(box, 'retry')
    await userEvent.keyboard('{Enter}')
    expect(box).toHaveValue('/retry')
    expect(screen.getByText('There is no answer to retry yet.', { selector: 'p' })).toBeVisible()
    expect(pending).toHaveLength(0)
  })

  it('asks before /clear empties a chat, then removes its messages and its saved copy', async () => {
    const { pending, chunk } = captureRequests()
    const box = await openPane()
    await userEvent.type(box, 'hi{Enter}')
    await waitFor(() => expect(pending).toHaveLength(1))
    await answer(pending, chunk, 'Hello there.')
    expect(await screen.findByText('Hello there.')).toBeInTheDocument()

    await userEvent.type(box, '/clear{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Clear this chat?' })
    expect(dialog).toHaveTextContent('Its 2 messages are removed')
    expect(screen.getByText('Hello there.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(screen.queryByText('Hello there.')).not.toBeInTheDocument())
    const sessionId = useChatStore.getState().current.w1
    expect(window.ostia.chatSessions.remove).toHaveBeenCalledWith(sessionId)
    expect(pending).toHaveLength(1)
  })

  it('keeps the chat when /clear is cancelled', async () => {
    const { pending, chunk } = captureRequests()
    const box = await openPane()
    await userEvent.type(box, 'hi{Enter}')
    await waitFor(() => expect(pending).toHaveLength(1))
    await answer(pending, chunk, 'Still here.')
    await userEvent.type(box, '/clear{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Clear this chat?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Still here.')).toBeInTheDocument()
    expect(window.ostia.chatSessions.remove).not.toHaveBeenCalled()
  })

  it('/rename asks for the title, then renames the chat', async () => {
    vi.mocked(window.ostia.chatSessions.rename).mockResolvedValue(null)
    const box = await openPane()
    await userEvent.type(box, '/ren{Enter}')
    expect(box).toHaveValue('/rename ')
    await userEvent.type(box, 'Release plan{Enter}')

    const sessionId = useChatStore.getState().current.w1
    expect(window.ostia.chatSessions.rename).toHaveBeenCalledWith(sessionId, 'Release plan')
    expect(useChatStore.getState().meta[sessionId].title).toBe('Release plan')
    expect(screen.getByText('Renamed to “Release plan”.')).toBeInTheDocument()
    expect(box).toHaveValue('')
  })

  it('/skill completes the configured skills and asks the model to load the chosen one', async () => {
    useAssistStore.setState({ availability: { chat: { ...CHAT, tools: 'native' } } })
    useSettingsStore.setState({
      assistant: {
        chatHistory: true,
        mcpServers: [],
        skillFolders: ['/home/u/skills'],
        providers: [],
        fastModel: null,
        chatModel: null,
      },
    })
    vi.mocked(window.ostia.chatTools.skills).mockResolvedValue([
      { name: 'pdf', description: 'Read and fill PDFs', path: '/home/u/skills/pdf/SKILL.md' },
      {
        name: 'release-notes',
        description: 'Write release notes',
        path: '/home/u/skills/release-notes/SKILL.md',
      },
    ])
    const { pending } = captureRequests()
    const box = await openPane()
    await userEvent.type(box, '/skill')
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /\/skill/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    )
    await userEvent.keyboard('{Enter}')
    expect(box).toHaveValue('/skill ')
    expect(screen.getByRole('listbox', { name: 'Choose for /skill' })).toBeInTheDocument()
    expect(options()).toEqual([
      expect.stringContaining('pdf'),
      expect.stringContaining('release-notes'),
    ])

    await userEvent.type(box, 'rel')
    expect(options()).toEqual([expect.stringContaining('release-notes')])
    await userEvent.keyboard('{Tab}')
    expect(box).toHaveValue('/skill release-notes ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await userEvent.type(box, 'for v2{Enter}')
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].input).toMatchObject({
      messages: [
        {
          role: 'user',
          content: 'Load the "release-notes" skill with load_skill, then: for v2',
        },
      ],
    })
  })

  it('/skill is greyed out with the reason when no skills are configured', async () => {
    useAssistStore.setState({ availability: { chat: { ...CHAT, tools: 'native' } } })
    const box = await openPane()
    await userEvent.type(box, '/sk')
    expect(screen.getByRole('option', { name: /\/skill/ })).toHaveTextContent(
      'No skill folders. Add one in Settings → Extensions → Assistant.',
    )
  })

  it('/explain sends the terminal context the human picks', async () => {
    const blocks = useBlocksStore.getState()
    blocks.promptStart(PANE, { line: 0 }, '/home/u/proj')
    blocks.promptEnd(PANE, { line: 0 })
    blocks.commandStart(PANE, { line: 1 }, 'make')
    blocks.commandEnd(PANE, { line: 2 }, 2)
    blocks.promptStart(PANE, { line: 3 }, '/home/u/proj')
    blocks.promptEnd(PANE, { line: 3 })
    blocks.commandStart(PANE, { line: 4 }, 'ls')
    blocks.commandEnd(PANE, { line: 5 }, 0)
    const made = useBlocksStore.getState().byPane[PANE]?.[0]
    blocks.select(PANE, made?.id ?? null)

    const { pending } = captureRequests()
    const box = await openPane()
    await userEvent.type(box, '/expl{Enter}')
    expect(box).toHaveValue('/explain ')
    expect(options()).toEqual([
      expect.stringContaining('Selected block: make'),
      expect.stringContaining('Output of ls'),
    ])
    await userEvent.keyboard('{ArrowDown}{Enter}')

    await waitFor(() => expect(pending).toHaveLength(1))
    const input = pending[0].input as { messages: { content: string }[]; context: object[] }
    expect(input.messages[0].content).toBe(
      'Explain what this output means and whether anything needs fixing.',
    )
    expect(input.context).toContainEqual({ kind: 'output', label: 'Output of ls', text: 'ls' })
    expect(input.context).not.toContainEqual(expect.objectContaining({ label: /make/ }))
  })

  it('/sessions completes saved chats and opens the chosen one', async () => {
    vi.mocked(window.ostia.chatSessions.list).mockResolvedValue([
      {
        id: 's-ports',
        workspaceId: 'w2',
        title: 'Ports on linux',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 2,
      },
    ])
    vi.mocked(window.ostia.chatSessions.get).mockResolvedValue({
      id: 's-ports',
      workspaceId: 'w2',
      title: 'Ports on linux',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'which ports?' }] }],
    })
    const box = await openPane()
    await userEvent.type(box, '/sessions por')
    await waitFor(() => expect(options()).toEqual([expect.stringContaining('Ports on linux')]))
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('which ports?')).toBeInTheDocument()
    expect(useChatStore.getState().current.w1).toBe('s-ports')
  })

  it('/new starts a fresh chat', async () => {
    const box = await openPane()
    const before = useChatStore.getState().current.w1
    await userEvent.type(box, '/new{Enter}')
    await waitFor(() => expect(useChatStore.getState().current.w1).not.toBe(before))
  })
})
