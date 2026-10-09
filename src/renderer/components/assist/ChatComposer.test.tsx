import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { CommandPalette } from '@/components/CommandPalette'
import { useAssistStore } from '@/stores/assistStore'
import { currentSessionId, resetChats, startNewSession, useChatStore } from '@/stores/chatStore'
import { modeFor, resetChatTools } from '@/stores/chatToolsStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { AssistCatalog, AssistChunk } from '@shared/assist'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPane } from './ChatPane'

vi.mock('@/lib/theme/colorize', () => ({ colorizeCode: async () => null }))

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const SMALL = { extId: 'assistant', provider: 'ollama', model: 'qwen-small' }
const BIG = {
  extId: 'assistant',
  provider: 'openai',
  model: 'gpt-very-long-model-name-2026-preview',
}
const LOCAL = { extId: 'model-runtime', provider: 'model-runtime', model: 'gemma' }

const CATALOG: AssistCatalog = {
  models: [
    { ref: SMALL, group: 'Ollama', label: SMALL.model, tools: 'prompted', points: ['chat'] },
    { ref: BIG, group: 'OpenAI', label: BIG.model, tools: 'native', points: ['chat'] },
    { ref: LOCAL, group: 'Model runtime', label: LOCAL.model, points: ['chat'] },
    {
      ref: { extId: 'assistant', provider: 'ollama', model: 'fast-only' },
      group: 'Ollama',
      label: 'fast-only',
      points: ['terminal'],
    },
  ],
  chat: SMALL,
  fast: SMALL,
}

function seed(): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'proj', kind: 'terminal', workDir: '/home/u/proj', state: 'idle' } as never,
    ],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      w1: {
        root: { type: 'pane', id: 'p-term', title: 'zsh', kind: 'terminal', cwd: '/home/u/proj' },
        activePaneId: 'p-term',
        zoomedPaneId: null,
      },
    },
  })
  useAssistStore.setState({
    availability: {
      chat: {
        extId: 'assistant',
        name: 'Assistant',
        label: 'Ollama · qwen-small',
        tools: 'prompted',
        ref: SMALL,
      },
    },
    catalog: CATALOG,
  })
}

interface Sent {
  input: unknown
  model: unknown
}

function captureRequests(): Sent[] {
  const sent: Sent[] = []
  const listeners = new Set<(c: AssistChunk) => void>()
  vi.mocked(window.ostia.assist.onChunk).mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  vi.mocked(window.ostia.assist.request).mockImplementation(
    async (_point, requestId, input, model) => {
      sent.push({ input, model })
      for (const text of [
        JSON.stringify({ type: 'start' }),
        JSON.stringify({ type: 'text-start', id: 't' }),
        JSON.stringify({ type: 'text-delta', id: 't', delta: 'ok' }),
        JSON.stringify({ type: 'text-end', id: 't' }),
        JSON.stringify({ type: 'finish' }),
      ]) {
        for (const cb of listeners) cb({ requestId, text })
      }
      return { ok: true, result: { text: 'ok' } } as never
    },
  )
  return sent
}

async function ask(question: string): Promise<void> {
  await userEvent.type(await screen.findByRole('combobox', { name: 'Your question' }), question)
  await userEvent.keyboard('{Enter}')
}

const modeButton = (): Promise<HTMLElement> => screen.findByRole('button', { name: /^Mode: / })
const modelButton = (): Promise<HTMLElement> => screen.findByRole('button', { name: /^Model: / })

describe('chat composer row', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let assistInit: ReturnType<typeof useAssistStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
    settingsInit = useSettingsStore.getState()
    assistInit = useAssistStore.getState()
  })

  beforeEach(() => {
    seed()
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
    useSettingsStore.setState(settingsInit, true)
    useAssistStore.setState(assistInit, true)
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.chatSessions.save).mockReset()
    vi.mocked(window.ostia.chatSessions.list).mockReset()
    vi.mocked(window.ostia.fs.write).mockClear()
  })

  it('puts tools on the left and mode, model and send on the right of one row that never wraps', async () => {
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    const send = await screen.findByRole('button', { name: 'Send' })
    const row = send.closest('.chat-composer-row') as HTMLElement
    expect(row).toHaveClass('flex-nowrap')
    const order = [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(order).toEqual([
      'Tools for this chat',
      'Mode: Ask',
      'Model: Ollama · qwen-small',
      'Send',
    ])
    const model = await modelButton()
    expect(model).toHaveClass('min-w-0', 'shrink')
    expect(within(model).getByText('qwen-small')).toHaveClass('truncate')
    expect(await modeButton()).toHaveClass('shrink-0')
  })

  it('keeps only the session title, saved state and new chat in the header', async () => {
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await modelButton()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
    const header = screen.getByRole('button', { name: 'New chat' }).parentElement as HTMLElement
    expect(header).not.toHaveTextContent('qwen-small')
    expect(header).toHaveTextContent('Saved')
  })

  it('starts every chat in Ask mode and switches to Write only from its menu, by keyboard too', async () => {
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    const button = await modeButton()
    expect(button).toHaveAttribute('data-mode', 'ask')
    const first = currentSessionId('w1') as string
    act(() => button.focus())
    await userEvent.keyboard('{Enter}')
    const write = await screen.findByRole('menuitemradio', { name: /^Write/ })
    expect(write).toHaveTextContent(
      'Edits inside the workspace folder apply right away. Each one can be undone.',
    )
    expect(screen.getByRole('menuitemradio', { name: /^Ask/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(modeFor(first)).toBe('write'))
    expect(await modeButton()).toHaveAttribute('data-mode', 'write')
    expect(await modeButton()).toHaveAccessibleName('Mode: Write')

    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    const second = currentSessionId('w1') as string
    expect(second).not.toBe(first)
    expect(await modeButton()).toHaveAttribute('data-mode', 'ask')
    expect(modeFor(first)).toBe('write')
  })

  it('never saves the mode with the chat or in settings', async () => {
    const sent = captureRequests()
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await userEvent.click(await modeButton())
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /^Write/ }))
    await ask('hi')
    await waitFor(() => expect(window.ostia.chatSessions.save).toHaveBeenCalled())
    expect(sent).toHaveLength(1)
    const saved = JSON.stringify(vi.mocked(window.ostia.chatSessions.save).mock.calls)
    expect(saved).not.toMatch(/"mode"|write/)
    expect(JSON.stringify(sent[0].input)).not.toMatch(/"mode"/)
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
  })

  it('lists the chat models by provider and sends the next question to the picked one', async () => {
    const sent = captureRequests()
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await ask('first')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].model).toEqual(SMALL)

    await userEvent.click(await modelButton())
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((o) => o.textContent)).toEqual([SMALL.model, BIG.model, LOCAL.model])
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Model runtime')).toBeInTheDocument()
    expect(options[0]).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(options[1])

    expect(await modelButton()).toHaveAccessibleName(`Model: OpenAI · ${BIG.model}`)
    await ask('second')
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].model).toEqual(BIG)
    const session = currentSessionId('w1') as string
    expect(useChatStore.getState().meta[session].modelRef).toEqual(BIG)
    await waitFor(() =>
      expect(vi.mocked(window.ostia.chatSessions.save).mock.calls.at(-1)?.[0].modelRef).toEqual(
        BIG,
      ),
    )
  })

  it('starts a new chat on the default model and keeps the pick of the earlier chat', async () => {
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await userEvent.click(await modelButton())
    await userEvent.click(await screen.findByRole('menuitemradio', { name: LOCAL.model }))
    const first = currentSessionId('w1') as string
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(await modelButton()).toHaveAccessibleName('Model: Ollama · qwen-small')
    expect(useChatStore.getState().meta[first].modelRef).toEqual(LOCAL)
  })

  it('falls back to the default model when the picked one is no longer offered', async () => {
    const sent = captureRequests()
    const id = startNewSession('w1')
    useChatStore.getState().setMeta({
      ...useChatStore.getState().meta[id],
      modelRef: { extId: 'assistant', provider: 'gone', model: 'x' },
    })
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    expect(await modelButton()).toHaveAccessibleName('Model: Ollama · qwen-small')
    await ask('hi')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].model).toEqual(SMALL)
  })

  it('leads to Settings → Assistant from the model menu', async () => {
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await userEvent.click(await modelButton())
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Manage models…' }))
    expect(useUIStore.getState().settingsSection).toBe('assistant')
  })

  it('shows no mode and no model, and cannot send, until a provider is set up', async () => {
    useAssistStore.setState({ availability: {}, catalog: { models: [], chat: null, fast: null } })
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    expect(await screen.findByRole('button', { name: 'Model: No model' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Mode: / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('has the same row in the palette Ask view', async () => {
    useUIStore.setState({ paletteOpen: true, paletteMode: 'ask' })
    render(<CommandPalette />)
    expect(await modeButton()).toHaveAttribute('data-mode', 'ask')
    expect(await modelButton()).toHaveAccessibleName('Model: Ollama · qwen-small')
  })
})

describe('open file context', () => {
  beforeEach(() => {
    seed()
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: {
            type: 'split',
            id: 's1',
            direction: 'row',
            sizes: [50, 50],
            children: [
              { type: 'pane', id: 'p-term', title: 'zsh', kind: 'terminal', cwd: '/home/u/proj' },
              {
                type: 'pane',
                id: 'p-edit',
                title: 'a.ts',
                kind: 'editor',
                filePath: '/home/u/proj/src/a.ts',
              },
            ],
          } as never,
          activePaneId: 'p-term',
          zoomedPaneId: null,
        },
      },
    })
    vi.mocked(window.ostia.chatSessions.list).mockResolvedValue([])
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
    useAssistStore.setState({ availability: {}, catalog: { models: [], chat: null, fast: null } })
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.chatSessions.list).mockReset()
  })

  it('sends the path of the file open in the editor, and nothing once its chip is off', async () => {
    const sent = captureRequests()
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    const chip = await screen.findByRole('button', { name: /Open file/ })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(chip).toHaveTextContent('a.ts')
    await ask('rename the function here')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect((sent[0].input as { context: unknown[] }).context).toContainEqual({
      kind: 'editor',
      label: 'Open file a.ts',
      text: 'The file the user has open in the editor.',
      path: '/home/u/proj/src/a.ts',
    })
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }))
    await userEvent.click(await screen.findByRole('button', { name: /Open file/ }))
    await ask('again')
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(
      (sent[1].input as { context: { kind: string }[] }).context.some((c) => c.kind === 'editor'),
    ).toBe(false)
  })
})
