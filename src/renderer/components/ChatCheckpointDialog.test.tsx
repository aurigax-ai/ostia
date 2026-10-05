import '@testing-library/jest-dom/vitest'
import type { ChatRestoreRequest } from '@shared/chatTools'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OstiaChatMessage } from '../lib/chatTransport'
import { type ChatEditRecord, resetChatTools, useChatToolsStore } from '../stores/chatToolsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ChatCheckpointDialog } from './ChatCheckpointDialog'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function edit(patch: Partial<ChatEditRecord> & Pick<ChatEditRecord, 'toolCallId'>): ChatEditRecord {
  return {
    sessionId: 's1',
    path: '/home/u/proj/a.ts',
    root: '/home/u/proj',
    existed: true,
    outside: false,
    symlink: false,
    auto: true,
    state: 'applied',
    version: 'va',
    seq: 1,
    decisions: [null],
    before: 'a0',
    after: 'a1',
    ...patch,
  }
}

const tool = (id: string) =>
  ({
    type: 'dynamic-tool',
    toolName: 'edit_file',
    toolCallId: id,
    state: 'output-available',
  }) as never

const MESSAGES: OstiaChatMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'change things' }] },
  { id: 'a1', role: 'assistant', parts: [tool('e1'), tool('e2'), tool('e3')] },
]

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  cleanup()
  resetChatTools()
  useWorkspacesStore.setState(workspacesInit, true)
  vi.mocked(window.ostia.chatTools.restore).mockReset()
})

function seed(): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'proj', kind: 'terminal', workDir: '/home/u/proj', state: 'idle' } as never,
    ],
    activeWorkspaceId: 'w1',
  })
  const store = useChatToolsStore.getState()
  store.recordEdit(edit({ toolCallId: 'e1', seq: 1 }))
  store.recordEdit(
    edit({ toolCallId: 'e2', seq: 2, path: '/home/u/proj/new.ts', existed: false, version: 'vn' }),
  )
  store.recordEdit(edit({ toolCallId: 'e3', seq: 3, path: '/home/u/proj/mine.ts', version: 'vm' }))
}

describe('ChatCheckpointDialog', () => {
  it('lists what goes back and what stays because the human changed it, then restores only the first', async () => {
    seed()
    vi.mocked(window.ostia.chatTools.restore).mockImplementation(async (req: ChatRestoreRequest) =>
      req.path.endsWith('mine.ts')
        ? { ok: false, error: 'changed', path: req.path }
        : {
            ok: true,
            path: req.path,
            removed: req.content === null,
            version: req.content === null ? null : 'v-restored',
          },
    )
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(
      <ChatCheckpointDialog
        sessionId="s1"
        workspaceId="w1"
        messages={MESSAGES}
        messageId="u1"
        onClose={onClose}
        onDone={onDone}
      />,
    )
    const back = await screen.findByRole('list', { name: 'These go back:' })
    expect(within(back).getByText('a.ts')).toBeInTheDocument()
    expect(within(back).getByText('new.ts')).toBeInTheDocument()
    expect(within(back).getByText('deleted, the chat created it')).toBeInTheDocument()
    const stays = screen.getByRole('list', { name: 'These stay as they are:' })
    expect(within(stays).getByText('mine.ts')).toBeInTheDocument()
    expect(within(stays).getByText('changed since the chat edited it')).toBeInTheDocument()
    expect(window.ostia.chatTools.restore).toHaveBeenCalledTimes(3)
    await userEvent.click(screen.getByRole('button', { name: 'Restore files (2)' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const writes = vi
      .mocked(window.ostia.chatTools.restore)
      .mock.calls.map((c) => c[0])
      .filter((req) => !req.check)
    expect(writes.map((r) => [r.path, r.content])).toEqual([
      ['/home/u/proj/a.ts', 'a0'],
      ['/home/u/proj/new.ts', null],
    ])
    expect(onDone).toHaveBeenCalledWith('Files restored: 2. Left as they are: 1.')
    expect(useChatToolsStore.getState().edits.e3.state).toBe('applied')
    expect(useChatToolsStore.getState().edits.e1.state).toBe('undone')
  })

  it('writes nothing on Cancel', async () => {
    seed()
    vi.mocked(window.ostia.chatTools.restore).mockResolvedValue({
      ok: true,
      path: '/x',
      removed: false,
      version: 'v-restored',
    })
    const onClose = vi.fn()
    render(
      <ChatCheckpointDialog
        sessionId="s1"
        workspaceId="w1"
        messages={MESSAGES}
        messageId="u1"
        onClose={onClose}
        onDone={vi.fn()}
      />,
    )
    await screen.findByRole('list', { name: 'These go back:' })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(
      vi.mocked(window.ostia.chatTools.restore).mock.calls.every((c) => c[0].check === true),
    ).toBe(true)
  })
})
