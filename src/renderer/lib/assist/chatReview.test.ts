import { openSession, resetChats, sessionOf, useChatStore } from '@/stores/chatStore'
import {
  type ChatEditRecord,
  requestApproval,
  resetChatTools,
  useChatToolsStore,
} from '@/stores/chatToolsStore'
import { CHAT_EDIT_TEXT_MAX, type ChatSession } from '@shared/assist/chatSessions'
import type { ChatRestoreRequest } from '@shared/assist/chatTools'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { acceptAll, rejectAll, reviewItems } from './chatReview'
import { decideTool } from './chatToolPermissions'

function edit(patch: Partial<ChatEditRecord> & Pick<ChatEditRecord, 'toolCallId'>): ChatEditRecord {
  return {
    sessionId: 's1',
    path: '/proj/a.ts',
    root: '/proj',
    existed: true,
    outside: false,
    symlink: false,
    auto: true,
    state: 'applied',
    version: 'v',
    seq: 1,
    decisions: [null],
    before: 'before',
    after: 'after',
    ...patch,
  }
}

function wait(toolCallId: string, path: string) {
  return requestApproval(
    {
      toolCallId,
      sessionId: 's1',
      toolName: 'edit_file',
      kind: 'write',
      grantable: false,
      input: {},
      detail: { path, exists: true, before: 'x\n', after: 'y\n' },
    },
    decideTool({
      name: 'edit_file',
      access: 'write',
      mode: 'ask',
      grants: new Set(),
      standing: new Set(),
    }),
    new AbortController().signal,
  )
}

let chatInit: ReturnType<typeof useChatStore.getState>

beforeAll(() => {
  chatInit = useChatStore.getState()
})

afterEach(() => {
  resetChatTools()
  resetChats()
  useChatStore.setState(chatInit, true)
  vi.mocked(window.ostia.chatTools.restore).mockReset()
  vi.mocked(window.ostia.chatSessions.get).mockReset()
})

describe('reviewItems', () => {
  it('lists Write-mode edits nobody reviewed yet, then the edit waiting for an answer, for one chat', () => {
    const store = useChatToolsStore.getState()
    store.recordEdit(edit({ toolCallId: 'e2', seq: 2, path: '/proj/b.ts' }))
    store.recordEdit(edit({ toolCallId: 'e1', seq: 1 }))
    store.recordEdit(edit({ toolCallId: 'kept', seq: 3, decisions: ['accepted'] }))
    store.recordEdit(edit({ toolCallId: 'gone', seq: 4, state: 'undone' }))
    store.recordEdit(edit({ toolCallId: 'other', seq: 5, sessionId: 's2' }))
    void wait('p1', '/proj/c.ts').catch(() => undefined)
    const { pending, edits } = useChatToolsStore.getState()
    expect(reviewItems('s1', pending, edits)).toEqual([
      { toolCallId: 'e1', path: '/proj/a.ts', pending: false },
      { toolCallId: 'e2', path: '/proj/b.ts', pending: false },
      { toolCallId: 'p1', path: '/proj/c.ts', pending: true },
    ])
  })

  it('Accept all keeps every applied edit and accepts the waiting one', async () => {
    useChatToolsStore.getState().recordEdit(edit({ toolCallId: 'e1' }))
    const answer = wait('p1', '/proj/c.ts')
    const { pending, edits } = useChatToolsStore.getState()
    acceptAll(reviewItems('s1', pending, edits))
    expect(await answer).toEqual({ approved: true, scope: 'once' })
    expect(useChatToolsStore.getState().edits.e1.decisions).toEqual(['accepted'])
    expect(window.ostia.chatTools.restore).not.toHaveBeenCalled()
  })

  it('Reject all rejects the waiting edit and undoes the applied ones newest first', async () => {
    const store = useChatToolsStore.getState()
    store.recordEdit(edit({ toolCallId: 'e1', seq: 1, before: 'a0', after: 'a1', version: 'v1' }))
    store.recordEdit(edit({ toolCallId: 'e2', seq: 2, before: 'a1', after: 'a2', version: 'v2' }))
    const answer = wait('p1', '/proj/c.ts')
    vi.mocked(window.ostia.chatTools.restore).mockImplementation(
      async (req: ChatRestoreRequest) => ({
        ok: true,
        path: req.path,
        removed: false,
        version: `v-${req.content}`,
      }),
    )
    const { pending, edits } = useChatToolsStore.getState()
    await rejectAll(reviewItems('s1', pending, edits))
    expect(await answer).toEqual({ approved: false })
    expect(vi.mocked(window.ostia.chatTools.restore).mock.calls.map((c) => c[0].expected)).toEqual([
      'v2',
      'v1',
    ])
    expect(useChatToolsStore.getState().edits.e1.state).toBe('undone')
    expect(useChatToolsStore.getState().edits.e2.state).toBe('undone')
  })
})

describe('edits saved with the chat', () => {
  it('saves what Undo needs, leaving out texts past the cap and memory-only fields', () => {
    const store = useChatToolsStore.getState()
    store.recordEdit(edit({ toolCallId: 'e1', undoError: 'changed' }))
    store.recordEdit(edit({ toolCallId: 'e2', seq: 2, before: 'x'.repeat(CHAT_EDIT_TEXT_MAX + 1) }))
    store.recordEdit(edit({ toolCallId: 'e3', sessionId: 's2' }))
    const session = sessionOf({ id: 's1', title: 't', createdAt: 1 }, [])
    expect(session.edits).toEqual([
      {
        toolCallId: 'e1',
        path: '/proj/a.ts',
        root: '/proj',
        existed: true,
        outside: false,
        symlink: false,
        auto: true,
        state: 'applied',
        version: 'v',
        seq: 1,
        decisions: [null],
        before: 'before',
        after: 'after',
      },
      expect.not.objectContaining({ before: expect.anything() }),
    ])
  })

  it('brings the edits back when a saved chat opens', async () => {
    const stored: ChatSession = {
      id: 's9',
      title: 'old',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      messages: [],
      edits: [
        {
          toolCallId: 'e1',
          path: '/proj/a.ts',
          root: '/proj',
          existed: true,
          outside: false,
          symlink: false,
          auto: false,
          state: 'applied',
          version: 'v',
          seq: 1,
          decisions: ['accepted'],
          before: 'b',
          after: 'a',
        },
      ],
    }
    vi.mocked(window.ostia.chatSessions.get).mockResolvedValue(stored)
    expect(await openSession('w1', 's9')).toBe(true)
    expect(useChatToolsStore.getState().edits.e1).toMatchObject({
      sessionId: 's9',
      before: 'b',
      version: 'v',
    })
  })
})
