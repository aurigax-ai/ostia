import '@testing-library/jest-dom/vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { CommandPalette } from '@/components/CommandPalette'
import { runConfirmed } from '@/lib/chatActions'
import { useAssistStore } from '@/stores/assistStore'
import { useBlocksStore } from '@/stores/blocksStore'
import { resetChats, useChatStore } from '@/stores/chatStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkflowsStore } from '@/stores/workflowsStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { AssistChunk } from '@shared/assist'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPane } from './ChatPane'

vi.mock('@/lib/colorize', () => ({ colorizeCode: async () => null }))

const blockActions = vi.hoisted(() => ({
  canTypeInto: vi.fn().mockReturnValue(true),
  insertCommand: vi.fn().mockReturnValue(true),
  runWhenIdle: vi.fn(),
}))

vi.mock('@/lib/blockActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blockActions')>()),
  ...blockActions,
}))

const agentPaste = vi.hoisted(() => vi.fn())

vi.mock('@/lib/terminalHandles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalHandles')>()),
  terminalFor: (paneId: string) =>
    paneId === 'agent-pane' ? { paste: agentPaste, getSelection: () => '' } : undefined,
}))

vi.mock('@/lib/sendPick', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sendPick')>()),
  canInsertReference: (paneId: string) => paneId === 'agent-pane',
}))

vi.mock('@/components/agents/PickSendPanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/agents/PickSendPanel')>()),
  useAgentTargets: () => [
    {
      paneId: 'agent-pane',
      workspaceId: 'w1',
      workspaceName: 'proj',
      title: 'claude',
      state: 'waiting',
      sameWorkspace: true,
    },
  ],
}))

const opened = vi.hoisted(() => ({ file: vi.fn(), at: vi.fn() }))

vi.mock('@/lib/openFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openFile')>()),
  openFileInWorkspace: opened.file,
  openFileAt: opened.at,
}))

const PANE = 'p-term'
const CHAT = {
  extId: 'assistant',
  name: 'Assistant',
  label: 'fake · big',
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
  const s = useBlocksStore.getState()
  s.promptStart(PANE, { line: 0 }, '/home/u/proj')
  s.promptEnd(PANE, { line: 0 })
}

interface Pending {
  requestId: string
  input: unknown
  resolve: (value: unknown) => void
}

function captureRequests(): { pending: Pending[]; answer: (text: string) => Promise<void> } {
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
  const answer = async (text: string): Promise<void> => {
    await waitFor(() => expect(pending.length).toBeGreaterThan(0))
    const last = pending[pending.length - 1]
    act(() => {
      for (const chunk of [
        { type: 'start' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ]) {
        for (const cb of listeners) cb({ requestId: last.requestId, text: JSON.stringify(chunk) })
      }
    })
    await act(async () => last.resolve({ ok: true, result: { text } }))
  }
  return { pending, answer }
}

async function ask(question: string): Promise<void> {
  await userEvent.type(await screen.findByRole('combobox', { name: 'Your question' }), question)
  await userEvent.keyboard('{Enter}')
}

async function askInPane(question: string, reply: string): Promise<HTMLElement> {
  const { answer } = captureRequests()
  render(<ChatPane workspaceId="w1" paneId="p-chat" />)
  await ask(question)
  await answer(reply)
  return screen.findByLabelText('Answer')
}

describe('chat actions', () => {
  let uiInit: ReturnType<typeof useUIStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    if (!commands.has('palette.toggle')) registerBuiltinCommands()
    uiInit = useUIStore.getState()
    blocksInit = useBlocksStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    seedWorkspace()
    useAssistStore.setState({ availability: { chat: CHAT } })
    vi.mocked(window.ostia.chatSessions.list).mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    resetChats()
    runConfirmed.clear()
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
    useBlocksStore.setState(blocksInit, true)
    useAssistStore.setState({ availability: {}, overview: [] })
    useWorkflowsStore.setState({ saveCommand: null })
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null })
    useLayoutStore.setState({ byWorkspace: {} })
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.chatSessions.list).mockReset()
    vi.mocked(window.ostia.chatSessions.saveFile).mockReset()
    vi.mocked(window.ostia.fs.list).mockReset()
    vi.mocked(window.ostia.fs.read).mockReset()
    blockActions.insertCommand.mockClear()
    blockActions.runWhenIdle.mockClear()
    agentPaste.mockClear()
    opened.file.mockClear()
    opened.at.mockClear()
  })

  it('focuses the question with the carried text when Tab switches the palette to Ask', async () => {
    useUIStore.setState({ paletteOpen: true })
    render(<CommandPalette />)
    await userEvent.type(await screen.findByRole('combobox'), 'how do I list files')
    await userEvent.keyboard('{Tab}')

    const question = await screen.findByRole('combobox', { name: 'Your question' })
    await waitFor(() => expect(question).toHaveFocus())
    expect(question).toHaveValue('how do I list files')
    expect((question as HTMLTextAreaElement).selectionStart).toBe('how do I list files'.length)
  })

  it('inserts a shell block at the idle prompt without Enter', async () => {
    const answer = await askInPane('list', '```bash\nls -la\n```')
    await userEvent.click(within(answer).getByRole('button', { name: 'Insert at prompt' }))

    expect(blockActions.insertCommand).toHaveBeenCalledWith(PANE, 'ls -la')
    expect(blockActions.insertCommand.mock.calls[0]).toHaveLength(2)
  })

  it('runs a block in a new terminal tab after showing the exact command once per session', async () => {
    const answer = await askInPane('list', '```bash\necho hi\n```')
    const run = within(answer).getByRole('button', { name: 'Run in new terminal' })
    await userEvent.click(run)

    const confirm = await screen.findByRole('dialog', { name: 'Run in a new terminal?' })
    expect(within(confirm).getByText('echo hi')).toBeInTheDocument()
    expect(blockActions.runWhenIdle).not.toHaveBeenCalled()
    await userEvent.click(within(confirm).getByRole('button', { name: 'Run' }))

    expect(blockActions.runWhenIdle).toHaveBeenCalledTimes(1)
    const [paneId, command] = blockActions.runWhenIdle.mock.calls[0]
    expect(paneId).not.toBe(PANE)
    expect(command).toBe('echo hi')
    expect(useLayoutStore.getState().byWorkspace.w1).toBeDefined()

    await userEvent.click(run)
    expect(blockActions.runWhenIdle).toHaveBeenCalledTimes(2)
  })

  it('puts a multi-line script through the risky paste check before running it', async () => {
    const answer = await askInPane('setup', '```bash\ncd /tmp\nls\n```')
    await userEvent.click(within(answer).getByRole('button', { name: 'Run in new terminal' }))

    const dialog = await screen.findByRole('dialog', { name: /multiple lines|Paste/i })
    expect(blockActions.runWhenIdle).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getAllByRole('button').at(-1) as HTMLElement)
    expect(blockActions.runWhenIdle.mock.calls[0][1]).toBe('cd /tmp\nls')
  })

  it('still asks before running a multi-line script when paste confirmation is off', async () => {
    useSettingsStore.getState().setTerminal({ warnOnRiskyPaste: false })
    const answer = await askInPane('setup', '```bash\ncd /tmp\nls\n```')
    await userEvent.click(within(answer).getByRole('button', { name: 'Run in new terminal' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('It has 2 lines')
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(blockActions.runWhenIdle).not.toHaveBeenCalled()
  })

  it('pastes a block into an agent as text only', async () => {
    const answer = await askInPane('fix', '```\nplease rerun the tests\n```')
    await userEvent.click(within(answer).getByRole('button', { name: 'Send to agent' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'claude' }))

    expect(agentPaste).toHaveBeenCalledWith('please rerun the tests')
    expect(window.ostia.pty.write).not.toHaveBeenCalledWith('agent-pane', '\r')
  })

  it('saves a code block as a file and opens it in the editor', async () => {
    vi.mocked(window.ostia.chatSessions.saveFile).mockResolvedValue({
      ok: true,
      path: '/home/u/proj/snippet.py',
    })
    const answer = await askInPane('py', '```python\nprint(1)\n```')
    await userEvent.click(within(answer).getByRole('button', { name: 'Save as file…' }))

    expect(window.ostia.chatSessions.saveFile).toHaveBeenCalledWith('snippet.py', 'print(1)\n')
    await waitFor(() => expect(opened.file).toHaveBeenCalledWith('/home/u/proj/snippet.py'))
  })

  it('opens Save as workflow with the block command', async () => {
    const answer = await askInPane('find', '```sh\nfind . -name "*.log"\n```')
    await userEvent.click(within(answer).getByRole('button', { name: 'Save as workflow…' }))

    expect(useWorkflowsStore.getState().saveCommand).toBe('find . -name "*.log"')
  })

  it('opens a path in an answer in the editor at its line, against the workspace folder', async () => {
    const answer = await askInPane('where', 'The bug is in src/app.ts:12 near the top.')
    await userEvent.click(within(answer).getByRole('button', { name: 'src/app.ts:12' }))

    expect(opened.at).toHaveBeenCalledWith('/home/u/proj/src/app.ts', 12, undefined)
  })

  it('replaces the tail when a question is edited and sent again', async () => {
    const { pending, answer } = captureRequests()
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)
    await ask('first question')
    await answer('first answer')
    await ask('second question')
    await answer('second answer')

    const questions = screen.getAllByLabelText('Your question')
    const firstTurn = questions.find((el) => el.textContent?.includes('first question'))
    await userEvent.click(
      within(firstTurn as HTMLElement).getByRole('button', { name: 'Edit and resend' }),
    )
    const box = screen.getByRole('combobox', { name: 'Your question' })
    expect(box).toHaveValue('first question')
    await userEvent.clear(box)
    await userEvent.type(box, 'better question{Enter}')

    await waitFor(() => expect(pending).toHaveLength(3))
    expect((pending[2].input as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'better question' },
    ])
    expect(screen.queryByText('second answer')).toBeNull()
  })

  it('attaches a file from the @ picker as a chip with its size and sends it as context', async () => {
    vi.mocked(window.ostia.fs.list).mockResolvedValue([{ name: 'README.md', dir: false }])
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, version: 'v1', text: 'hello' })
    const { pending } = captureRequests()
    render(<ChatPane workspaceId="w1" paneId="p-chat" />)

    await userEvent.type(await screen.findByRole('combobox', { name: 'Your question' }), '@')
    await userEvent.click(await screen.findByRole('option', { name: /README\.md/ }))

    const chips = await screen.findByRole('list', { name: 'Attached to the next question' })
    const chip = within(chips).getByRole('button', { name: /README\.md sends/ })
    expect(chip).toHaveTextContent('5')
    expect(screen.getByRole('combobox', { name: 'Your question' })).toHaveValue('')

    await ask('summarize')
    await waitFor(() => expect(pending).toHaveLength(1))
    expect((pending[0].input as { context: unknown[] }).context).toContainEqual({
      kind: 'file',
      label: 'README.md',
      text: 'hello',
      path: '/home/u/proj/README.md',
    })
    expect(screen.queryByRole('list', { name: 'Attached to the next question' })).toBeNull()
  })
})
