import type { ChatRestoreRequest } from '@shared/chatTools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChatEditRecord, resetChatTools, useChatToolsStore } from '../stores/chatToolsStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { checkCheckpoint, checkpointFiles, restoreCheckpoint } from './chatCheckpoint'

const A = '/proj/a.ts'
const B = '/proj/b.ts'

function edit(patch: Partial<ChatEditRecord> & Pick<ChatEditRecord, 'toolCallId'>): ChatEditRecord {
  return {
    sessionId: 's1',
    path: A,
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

function call(id: string) {
  return { type: 'dynamic-tool', toolCallId: id }
}

const MESSAGES = [
  { id: 'u1', role: 'user', parts: [{ type: 'text' }] },
  { id: 'a1', role: 'assistant', parts: [call('e1')] },
  { id: 'u2', role: 'user', parts: [{ type: 'text' }] },
  { id: 'a2', role: 'assistant', parts: [call('e2'), call('e3')] },
  { id: 'u3', role: 'user', parts: [{ type: 'text' }] },
  { id: 'a3', role: 'assistant', parts: [call('e4')] },
]

const RECORDS = [
  edit({ toolCallId: 'e1', seq: 1, before: 'a0', after: 'a1', version: 'va1' }),
  edit({ toolCallId: 'e2', seq: 2, before: 'a1', after: 'a2', version: 'va2' }),
  edit({
    toolCallId: 'e3',
    seq: 3,
    path: B,
    existed: false,
    before: '',
    after: 'b',
    version: 'vb',
  }),
  edit({ toolCallId: 'e4', seq: 4, before: 'a2', after: 'a3', version: 'va3' }),
]

afterEach(() => {
  resetChatTools()
  vi.mocked(window.ostia.chatTools.restore).mockReset()
  useEditorStatus.setState({ dirty: {} })
})

describe('checkpointFiles', () => {
  it('restores each file this chat changed after the message to how it was before it', () => {
    expect(checkpointFiles(MESSAGES, RECORDS, 'u2')).toEqual([
      expect.objectContaining({
        path: A,
        expected: 'va3',
        content: 'a1',
        kept: true,
        created: false,
        toolCallIds: ['e2', 'e4'],
      }),
      expect.objectContaining({
        path: B,
        expected: 'vb',
        content: null,
        kept: true,
        created: true,
        toolCallIds: ['e3'],
      }),
    ])
    expect(checkpointFiles(MESSAGES, RECORDS, 'u3').map((f) => [f.path, f.content])).toEqual([
      [A, 'a2'],
    ])
  })

  it('offers nothing for an assistant message, the last turn, or files whose edits were undone', () => {
    expect(checkpointFiles(MESSAGES, RECORDS, 'a1')).toEqual([])
    expect(
      checkpointFiles([...MESSAGES, { id: 'u4', role: 'user', parts: [] }], RECORDS, 'u4'),
    ).toEqual([])
    const undone = RECORDS.map((r) =>
      r.toolCallId === 'e4' ? { ...r, state: 'undone' as const } : r,
    )
    expect(checkpointFiles(MESSAGES, undone, 'u3')).toEqual([])
  })

  it('expects the version the chat left the file in last, even after an undo', () => {
    const records = RECORDS.map((r) =>
      r.toolCallId === 'e1' ? { ...r, seq: 9, state: 'undone' as const, version: 'va0' } : r,
    )
    expect(checkpointFiles(MESSAGES, records, 'u2')[0].expected).toBe('va0')
  })

  it('marks a file whose earlier text was not kept with the chat', () => {
    const records = RECORDS.map((r) => {
      if (r.toolCallId !== 'e2') return r
      const { before: _b, after: _a, ...rest } = r
      return rest
    })
    expect(checkpointFiles(MESSAGES, records, 'u2')[0]).toMatchObject({ kept: false })
  })
})

describe('checkCheckpoint and restoreCheckpoint', () => {
  it('checks each file in main without writing, and names the ones that changed or are unsaved', async () => {
    useEditorStatus.getState().setDirty('/proj/link/b.ts', true)
    vi.mocked(window.ostia.chatTools.restore).mockImplementation(async (req: ChatRestoreRequest) =>
      req.path === A
        ? { ok: false, error: 'changed', path: A }
        : { ok: true, path: B, removed: true, version: null },
    )
    const files = checkpointFiles(MESSAGES, RECORDS, 'u2')
    const checks = await checkCheckpoint([
      ...files,
      { ...files[0], path: '/proj/c.ts', kept: false },
    ])
    expect(checks.map((c) => [c.file.path, c.status])).toEqual([
      [A, 'changed'],
      [B, 'ready'],
      ['/proj/c.ts', 'not-kept'],
    ])
    expect(vi.mocked(window.ostia.chatTools.restore).mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ path: A, expected: 'va3', content: 'a1', check: true }),
      expect.objectContaining({
        path: B,
        expected: 'vb',
        content: null,
        check: true,
        dirty: ['/proj/link/b.ts'],
      }),
    ])
  })

  it('restores the files and marks their later edits undone, so the next checkpoint expects the restored version', async () => {
    for (const r of RECORDS) useChatToolsStore.getState().recordEdit(r)
    vi.mocked(window.ostia.chatTools.restore).mockImplementation(
      async (req: ChatRestoreRequest) => ({
        ok: true,
        path: req.path,
        removed: req.content === null,
        version: req.content === null ? null : `v-${req.content}`,
      }),
    )
    const files = checkpointFiles(MESSAGES, RECORDS, 'u2')
    const results = await restoreCheckpoint('s1', files)
    expect(results.map((r) => r.status)).toEqual(['ready', 'ready'])
    const { edits, versions } = useChatToolsStore.getState()
    expect(['e1', 'e2', 'e3', 'e4'].map((id) => edits[id].state)).toEqual([
      'applied',
      'undone',
      'undone',
      'undone',
    ])
    expect(edits.e2.version).toBe('v-a1')
    expect(versions.s1[A]).toBe('v-a1')
    expect(versions.s1[B]).toBeUndefined()
    const after = Object.values(edits)
    expect(checkpointFiles(MESSAGES, after, 'u1')[0]).toMatchObject({
      path: A,
      expected: 'v-a1',
      content: 'a0',
    })
  })
})
