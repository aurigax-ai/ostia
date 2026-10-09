import { useAssistStore } from '@/stores/assistStore'
import {
  answerApproval,
  removeAlwaysGrant,
  resetChatTools,
  useChatToolsStore,
} from '@/stores/chatToolsStore'
import { useEditorStatus } from '@/stores/editorStatusStore'
import {
  type AssistChunk,
  type AssistModelRef,
  type ChatAssistRequest,
  EMPTY_ASSIST_CATALOG,
} from '@shared/assist'
import type { ChatPlanOutput, ChatPreviewOutput, ChatWriteOutput } from '@shared/assist/chatTools'
import type { UIMessageChunk } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decideHunk, undoEdit } from './chatReview'
import {
  OLD_TOOL_OUTPUT_MAX,
  type OstiaChatMessage,
  STOPPED_TOOL_ERROR,
  createAssistTransport,
  toChatRequest,
} from './chatTransport'

function user(id: string, text: string): OstiaChatMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

function replySequence(rounds: string[][]): void {
  const listeners = new Set<(c: AssistChunk) => void>()
  vi.mocked(window.ostia.assist.onChunk).mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  let round = 0
  vi.mocked(window.ostia.assist.request).mockImplementation(async (_point, requestId) => {
    const chunks = rounds[Math.min(round, rounds.length - 1)]
    round += 1
    for (const text of chunks) for (const cb of listeners) cb({ requestId, text })
    return { ok: true, result: { text: '' } } as never
  })
}

const J = (v: unknown): string => JSON.stringify(v)

function toolRound(id: string, name: string, input: unknown): string[] {
  return [
    J({ type: 'start' }),
    J({ type: 'start-step' }),
    J({ type: 'tool-input-start', toolCallId: id, toolName: name, dynamic: true }),
    J({ type: 'tool-input-available', toolCallId: id, toolName: name, input, dynamic: true }),
    J({ type: 'finish-step' }),
    J({ type: 'finish' }),
  ]
}

function textRound(text: string): string[] {
  return [
    J({ type: 'start' }),
    J({ type: 'start-step' }),
    J({ type: 'text-start', id: 'x' }),
    J({ type: 'text-delta', id: 'x', delta: text }),
    J({ type: 'text-end', id: 'x' }),
    J({ type: 'finish-step' }),
    J({ type: 'finish' }),
  ]
}

let sessionModel: AssistModelRef | null = null

function preview(patch: Partial<ChatPreviewOutput> = {}) {
  return {
    ok: true as const,
    path: '/proj/b.txt',
    exists: true,
    text: 'old',
    version: 'v-old',
    outside: false,
    symlink: false,
    unsaved: false,
    ...patch,
  }
}

function plan(patch: Partial<ChatPlanOutput> = {}) {
  return {
    ok: true as const,
    path: '/proj/b.txt',
    before: 'one two',
    after: 'one 2',
    version: 'v-old',
    outside: false,
    symlink: false,
    unsaved: false,
    ...patch,
  }
}

function written(patch: Partial<ChatWriteOutput> = {}) {
  return {
    ok: true as const,
    path: '/proj/b.txt',
    created: false,
    bytes: 5,
    version: 'v-new',
    ...patch,
  }
}

function sendWithTools(messages: OstiaChatMessage[], abortSignal?: AbortSignal, sessionId = 's1') {
  return createAssistTransport({
    sessionId,
    workspaceId: () => null,
    root: () => '/proj',
    model: () => sessionModel,
  }).sendMessages({
    trigger: 'submit-message',
    chatId: sessionId,
    messageId: undefined,
    messages,
    abortSignal,
  })
}

async function pendingApproval(): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const ids = Object.keys(useChatToolsStore.getState().pending)
    if (ids.length > 0) return ids[0]
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('no approval was requested')
}

async function waitForPending(match: (p: { kind: string }) => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (Object.values(useChatToolsStore.getState().pending).some(match)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('no matching approval')
}

function requestAt(n: number): ChatAssistRequest {
  return vi.mocked(window.ostia.assist.request).mock.calls[n][2] as ChatAssistRequest
}

const DENY_ALL_BUILTINS = [
  'read_file',
  'list_directory',
  'search_files',
  'terminal_context',
  'git_status',
  'propose_command',
  'edit_file',
  'write_file',
  'open_file',
  'open_url',
]

describe('createAssistTransport with tools', () => {
  beforeEach(() => {
    useAssistStore.setState({
      availability: {
        chat: { extId: 'a', name: 'A', label: 'fake', tools: 'native', ref: { extId: 'a' } },
      },
    })
  })

  afterEach(() => {
    vi.mocked(window.ostia.assist.request).mockReset()
    vi.mocked(window.ostia.chatTools.read).mockReset()
    vi.mocked(window.ostia.chatTools.preview).mockReset()
    vi.mocked(window.ostia.chatTools.write).mockReset()
    vi.mocked(window.ostia.chatTools.plan).mockReset()
    vi.mocked(window.ostia.chatTools.restore).mockReset()
    vi.mocked(window.ostia.chatTools.mcpCall).mockReset()
    vi.mocked(window.ostia.privacy.redact).mockImplementation(async (texts) =>
      texts.map((text) => ({ text, count: 0, kinds: {} })),
    )
    sessionModel = null
    useAssistStore.setState({ availability: {}, catalog: EMPTY_ASSIST_CATALOG })
    resetChatTools()
  })

  it('offers the tools, runs a read-only tool without asking and sends its result back', async () => {
    vi.mocked(window.ostia.chatTools.read).mockResolvedValue({
      ok: true,
      path: '/proj/a.txt',
      text: 'hi',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
      version: 'v-a',
    })
    replySequence([toolRound('t1', 'read_file', { path: 'a.txt' }), textRound('It says hi')])
    const chunks = await drain(await sendWithTools([user('1', 'what is in a.txt')]))
    expect(requestAt(0).tools?.map((t) => t.name)).toContain('read_file')
    expect(vi.mocked(window.ostia.chatTools.read).mock.calls[0][0]).toMatchObject({
      path: '/proj/a.txt',
      root: '/proj',
      outside: false,
    })
    expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(false)
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 't1',
      output: { path: '/proj/a.txt', text: 'hi' },
    })
    const turn = requestAt(1).messages.at(-1)
    expect(turn?.role).toBe('assistant')
    expect(turn?.tools?.[0]).toMatchObject({ id: 't1', name: 'read_file', state: 'done' })
    expect(turn?.tools?.[0].output).toContain('"text":"hi"')
    expect(turn?.tools?.[0].output).not.toContain('v-a')
    expect(useChatToolsStore.getState().versions.s1).toEqual({ '/proj/a.txt': 'v-a' })
    expect(chunks.filter((c) => c.type === 'start')).toHaveLength(1)
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('redacts a tool result before it is shown, stored or sent back to the model', async () => {
    vi.mocked(window.ostia.privacy.redact).mockImplementation(async (texts) =>
      texts.map((text) => {
        const count = text.split('SECRET').length - 1
        return { text: text.replaceAll('SECRET', '[redacted:test]'), count, kinds: {} }
      }),
    )
    vi.mocked(window.ostia.chatTools.read).mockResolvedValue({
      ok: true,
      path: '/proj/.env',
      text: 'API_KEY=SECRET',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
      version: 'v-a',
    })
    replySequence([toolRound('t1', 'read_file', { path: '.env' }), textRound('done')])
    const chunks = await drain(await sendWithTools([user('1', 'read .env')]))
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 't1',
      output: { path: '/proj/.env', text: 'API_KEY=[redacted:test]', totalLines: 1 },
    })
    const sent = requestAt(1).messages.at(-1)?.tools?.[0].output
    expect(sent).toContain('API_KEY=[redacted:test]')
    expect(sent).not.toContain('SECRET')
  })

  it('asks before reading outside the workspace folder', async () => {
    vi.mocked(window.ostia.chatTools.read)
      .mockResolvedValueOnce({ ok: false, error: 'outside-folder', path: '/etc/hosts' })
      .mockResolvedValueOnce({
        ok: true,
        path: '/etc/hosts',
        text: 'x',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
        version: 'v-h',
      })
    replySequence([toolRound('r1', 'read_file', { path: '/etc/hosts' }), textRound('ok')])
    const draining = sendWithTools([user('1', 'hosts?')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id]).toMatchObject({
      kind: 'read-outside',
      grantable: true,
    })
    answerApproval(id, { approved: true, scope: 'once' })
    await draining
    expect(vi.mocked(window.ostia.chatTools.read).mock.calls[1][0]).toMatchObject({
      outside: true,
    })
  })

  it('in Ask mode a whole-file write waits; Reject records a denied call and writes nothing', async () => {
    vi.mocked(window.ostia.chatTools.preview).mockResolvedValue(preview())
    replySequence([
      toolRound('w1', 'write_file', { path: 'b.txt', content: 'new' }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'change b')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id]).toMatchObject({
      kind: 'write',
      grantable: false,
      detail: { path: '/proj/b.txt', before: 'old', after: 'new', reason: 'ask-mode' },
    })
    answerApproval(id, { approved: false })
    const chunks = await draining
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
    expect(chunks.map((c) => c.type)).toEqual(
      expect.arrayContaining([
        'tool-approval-request',
        'tool-approval-response',
        'tool-output-denied',
      ]),
    )
    expect(requestAt(1).messages.at(-1)?.tools?.[0]).toMatchObject({ state: 'denied' })
    expect(useChatToolsStore.getState().edits).toEqual({})
  })

  it('in Ask mode it writes after Accept, and asks again for the next write', async () => {
    vi.mocked(window.ostia.chatTools.preview).mockResolvedValue(
      preview({ exists: false, text: '', version: null }),
    )
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue(written({ created: true, bytes: 3 }))
    replySequence([
      toolRound('w1', 'write_file', { path: 'b.txt', content: 'new' }),
      toolRound('w2', 'write_file', { path: 'b.txt', content: 'again' }),
      textRound('done'),
    ])
    const draining = sendWithTools([user('1', 'write b')]).then(drain)
    answerApproval(await pendingApproval(), { approved: true, scope: 'once' })
    answerApproval(await pendingApproval(), { approved: false })
    const chunks = await draining
    expect(window.ostia.chatTools.write).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.ostia.chatTools.write).mock.calls[0][0]).toEqual({
      path: '/proj/b.txt',
      root: '/proj',
      outside: false,
      symlinks: false,
      content: 'new',
      base: null,
    })
    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(2)
    expect(useChatToolsStore.getState().edits.w1).toMatchObject({
      path: '/proj/b.txt',
      existed: false,
      before: '',
      after: 'new',
      version: 'v-new',
      auto: false,
      state: 'applied',
    })
    expect(chunks.find((c) => c.type === 'tool-output-available')).toMatchObject({
      output: { path: '/proj/b.txt', created: true, added: 1, removed: 0 },
    })
  })

  it('plans a targeted edit in main with the version the chat read, and shows it as a diff', async () => {
    vi.mocked(window.ostia.chatTools.read).mockResolvedValue({
      ok: true,
      path: '/proj/b.txt',
      text: 'one two',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
      version: 'v-old',
    })
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(plan())
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue(written())
    const edits = [{ old_text: 'two', new_text: '2' }]
    replySequence([
      toolRound('r1', 'read_file', { path: 'b.txt' }),
      toolRound('e1', 'edit_file', { path: 'b.txt', edits }),
      textRound('done'),
    ])
    const draining = sendWithTools([user('1', 'make two a digit')]).then(drain)
    const id = await pendingApproval()
    expect(vi.mocked(window.ostia.chatTools.plan).mock.calls[0][0]).toEqual({
      path: '/proj/b.txt',
      root: '/proj',
      edits: [{ oldText: 'two', newText: '2' }],
      outside: false,
      dirty: [],
    })
    expect(useChatToolsStore.getState().pending[id].detail).toMatchObject({
      path: '/proj/b.txt',
      exists: true,
      before: 'one two',
      after: 'one 2',
    })
    answerApproval(id, { approved: true, scope: 'once' })
    await draining
    expect(vi.mocked(window.ostia.chatTools.write).mock.calls[0][0]).toMatchObject({
      content: 'one 2',
      base: 'v-old',
    })
    expect(useChatToolsStore.getState().versions.s1['/proj/b.txt']).toBe('v-new')
  })

  it('in Write mode an edit inside the workspace folder applies without asking and can be undone', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(plan())
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue(written())
    vi.mocked(window.ostia.chatTools.restore).mockResolvedValue({
      ok: true,
      path: '/proj/b.txt',
      removed: false,
      version: 'v-old',
    })
    replySequence([
      toolRound('e1', 'edit_file', { path: 'b.txt', edits: [{ old_text: 'two', new_text: '2' }] }),
      textRound('done'),
    ])
    const chunks = await drain(await sendWithTools([user('1', 'edit')]))
    expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(false)
    expect(window.ostia.chatTools.write).toHaveBeenCalledTimes(1)
    expect(useChatToolsStore.getState().edits.e1).toMatchObject({ auto: true, state: 'applied' })
    await undoEdit('e1')
    expect(vi.mocked(window.ostia.chatTools.restore).mock.calls[0][0]).toEqual({
      path: '/proj/b.txt',
      root: '/proj',
      outside: false,
      symlinks: false,
      expected: 'v-new',
      content: 'one two',
      dirty: [],
    })
    expect(useChatToolsStore.getState().edits.e1.state).toBe('undone')
    expect(useChatToolsStore.getState().versions.s1['/proj/b.txt']).toBe('v-old')
  })

  it.each([
    ['outside the workspace folder', { outside: true, symlink: false }, 'outside'],
    ['through a symlink', { outside: false, symlink: true }, 'symlink'],
  ] as const)('in Write mode a write %s still asks', async (_label, flags, reason) => {
    useChatToolsStore.getState().setMode('s1', 'write')
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(plan(flags))
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue(written())
    replySequence([
      toolRound('e1', 'edit_file', { path: 'b.txt', edits: [{ old_text: 'two', new_text: '2' }] }),
      textRound('done'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id]).toMatchObject({
      kind: 'write',
      grantable: false,
      detail: { reason },
    })
    answerApproval(id, { approved: true, scope: 'once' })
    await draining
    expect(vi.mocked(window.ostia.chatTools.write).mock.calls[0][0]).toMatchObject({
      outside: flags.outside,
      symlinks: flags.symlink,
    })
    expect(useChatToolsStore.getState().edits.e1.auto).toBe(false)
  })

  it('asks to read outside the folder before planning an edit there, then shows the edit for approval', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    vi.mocked(window.ostia.chatTools.plan)
      .mockResolvedValueOnce({ ok: false, error: 'outside-folder', path: '/etc/x.conf' })
      .mockResolvedValueOnce(plan({ path: '/etc/x.conf', outside: true }))
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue(written({ path: '/etc/x.conf' }))
    replySequence([
      toolRound('e1', 'edit_file', {
        path: '/etc/x.conf',
        edits: [{ old_text: 'two', new_text: '2' }],
      }),
      textRound('done'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    const first = await pendingApproval()
    expect(useChatToolsStore.getState().pending[first]).toMatchObject({ kind: 'read-outside' })
    expect(vi.mocked(window.ostia.chatTools.plan).mock.calls[0][0].outside).toBe(false)
    answerApproval(first, { approved: true, scope: 'once' })
    await waitForPending((p) => p.kind === 'write')
    const second = Object.keys(useChatToolsStore.getState().pending)[0]
    expect(vi.mocked(window.ostia.chatTools.plan).mock.calls[1][0].outside).toBe(true)
    expect(useChatToolsStore.getState().pending[second].detail.reason).toBe('outside')
    answerApproval(second, { approved: true, scope: 'once' })
    await draining
    expect(window.ostia.chatTools.write).toHaveBeenCalledTimes(1)
  })

  it('says nothing about the file and writes nothing when the human refuses the outside read', async () => {
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValueOnce({
      ok: false,
      error: 'outside-folder',
      path: '/etc/x.conf',
    })
    replySequence([
      toolRound('e1', 'edit_file', {
        path: '/etc/x.conf',
        edits: [{ old_text: 'two', new_text: '2' }],
      }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    answerApproval(await pendingApproval(), { approved: false })
    const chunks = await draining
    expect(window.ostia.chatTools.plan).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'tool-output-denied')).toBe(true)
  })

  it('in Write mode an edit inside a .git folder still asks', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(plan({ path: '/proj/.git/config' }))
    replySequence([
      toolRound('e1', 'edit_file', {
        path: '.git/config',
        edits: [{ old_text: 'two', new_text: '2' }],
      }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id].detail.reason).toBe('repository')
    answerApproval(id, { approved: false })
    await draining
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
  })

  it('undoes once even when Undo is clicked twice', async () => {
    useChatToolsStore.getState().recordEdit({
      toolCallId: 'e1',
      sessionId: 's1',
      path: '/proj/b.txt',
      root: '/proj',
      existed: true,
      before: 'one two',
      after: 'one 2',
      version: 'v-new',
      outside: false,
      symlink: false,
      auto: true,
      state: 'applied',
      seq: 1,
      decisions: [null],
    })
    vi.mocked(window.ostia.chatTools.restore)
      .mockResolvedValueOnce({ ok: true, path: '/proj/b.txt', removed: false, version: 'v-old' })
      .mockResolvedValueOnce({ ok: false, error: 'changed' })
    await Promise.all([undoEdit('e1'), undoEdit('e1')])
    expect(window.ostia.chatTools.restore).toHaveBeenCalledTimes(1)
    expect(useChatToolsStore.getState().edits.e1.state).toBe('undone')
  })

  it('in Write mode a file with unsaved edits in the editor still asks, as main finds it by real path', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    useEditorStatus.getState().setDirty('/home/u/link/b.txt', true)
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(plan({ unsaved: true }))
    replySequence([
      toolRound('e1', 'edit_file', { path: 'b.txt', edits: [{ old_text: 'two', new_text: '2' }] }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    const id = await pendingApproval()
    expect(vi.mocked(window.ostia.chatTools.plan).mock.calls[0][0].dirty).toEqual([
      '/home/u/link/b.txt',
    ])
    expect(useChatToolsStore.getState().pending[id].detail.reason).toBe('unsaved')
    answerApproval(id, { approved: false })
    await draining
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
    useEditorStatus.getState().setDirty('/home/u/link/b.txt', false)
  })

  it('writes only the changes the human accepted and tells the model the rest were rejected', async () => {
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(
      plan({ before: 'a\nb\nc\nd\ne\n', after: 'A\nb\nc\nd\nE\n' }),
    )
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue(written())
    replySequence([
      toolRound('e1', 'edit_file', {
        path: 'b.txt',
        edits: [
          { old_text: 'a', new_text: 'A' },
          { old_text: 'e', new_text: 'E' },
        ],
      }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    const id = await pendingApproval()
    await decideHunk(id, 1, 'rejected')
    expect(useChatToolsStore.getState().pending[id]).toBeDefined()
    await decideHunk(id, 0, 'accepted')
    const chunks = await draining
    expect(vi.mocked(window.ostia.chatTools.write).mock.calls[0][0]).toMatchObject({
      content: 'A\nb\nc\nd\ne\n',
      base: 'v-old',
    })
    expect(useChatToolsStore.getState().edits.e1).toMatchObject({
      after: 'A\nb\nc\nd\nE\n',
      decisions: ['accepted', 'rejected'],
      auto: false,
    })
    expect(useChatToolsStore.getState().hunkChoices.e1).toBeUndefined()
    const output = chunks.find((c) => c.type === 'tool-output-available') as {
      output: Record<string, unknown>
    }
    expect(output.output).toMatchObject({ added: 1, removed: 1, rejectedChanges: 1 })
    expect(String(output.output.note)).toContain('Read it again')
  })

  it('rejects the whole edit when the human rejects every change', async () => {
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(
      plan({ before: 'a\nb\nc\nd\ne\n', after: 'A\nb\nc\nd\nE\n' }),
    )
    replySequence([
      toolRound('e1', 'edit_file', { path: 'b.txt', edits: [{ old_text: 'a', new_text: 'A' }] }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    const id = await pendingApproval()
    await decideHunk(id, 0, 'rejected')
    await decideHunk(id, 1, 'rejected')
    const chunks = await draining
    expect(chunks.some((c) => c.type === 'tool-output-denied')).toBe(true)
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
  })

  it('in Write mode a command proposal still asks every time', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    replySequence([toolRound('c1', 'propose_command', { command: 'ls' }), textRound('ok')])
    const draining = sendWithTools([user('1', 'list')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id]).toMatchObject({
      kind: 'command',
      grantable: false,
    })
    answerApproval(id, { approved: false })
    await draining
  })

  it('tells the model plainly why an edit failed, also when the file changed since it was read, and writes nothing', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    const edit = { path: 'b.txt', edits: [{ old_text: 'two', new_text: '2' }] }
    vi.mocked(window.ostia.chatTools.plan)
      .mockResolvedValueOnce({ ok: false, error: 'no-match', path: '/proj/b.txt', edit: 0 })
      .mockResolvedValueOnce({
        ok: false,
        error: 'ambiguous',
        path: '/proj/b.txt',
        edit: 1,
        count: 3,
      })
      .mockResolvedValueOnce(plan({ version: 'v-now' }))
    useChatToolsStore.getState().setVersion('s1', '/proj/b.txt', 'v-read')
    replySequence([
      toolRound('e1', 'edit_file', edit),
      toolRound('e2', 'edit_file', edit),
      toolRound('e3', 'edit_file', edit),
      toolRound('e4', 'edit_file', { path: 'b.txt', edits: 'two' }),
      textRound('sorry'),
    ])
    const chunks = await drain(await sendWithTools([user('1', 'edit')]))
    const errors = chunks
      .filter((c) => c.type === 'tool-output-error')
      .map((c) => (c.type === 'tool-output-error' ? c.errorText : ''))
    expect(errors[0]).toMatch(/^Edit 1: old_text was not found/)
    expect(errors[1]).toMatch(/^Edit 2: old_text matches more than one place.*\(3 matches\)/)
    expect(errors[2]).toMatch(/changed on disk since it was last read; nothing was written/)
    expect(errors[3]).toMatch(/edits must be a list/)
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
    expect(useChatToolsStore.getState().failures).toEqual({
      e1: 'no-match',
      e2: 'ambiguous',
      e3: 'changed',
    })
  })

  it('refuses to replace a whole file that changed since the chat read it', async () => {
    useChatToolsStore.getState().setMode('s1', 'write')
    useChatToolsStore.getState().setVersion('s1', '/proj/b.txt', 'v-read')
    vi.mocked(window.ostia.chatTools.preview).mockResolvedValue(preview({ version: 'v-now' }))
    replySequence([
      toolRound('w1', 'write_file', { path: 'b.txt', content: 'new' }),
      textRound('ok'),
    ])
    const chunks = await drain(await sendWithTools([user('1', 'write')]))
    expect(chunks.find((c) => c.type === 'tool-output-error')).toMatchObject({
      errorText: expect.stringMatching(/changed on disk/),
    })
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
  })

  it('reports a write that lost the race with another change as a failure the card can explain', async () => {
    vi.mocked(window.ostia.chatTools.plan).mockResolvedValue(plan())
    vi.mocked(window.ostia.chatTools.write).mockResolvedValue({
      ok: false,
      error: 'changed',
      path: '/proj/b.txt',
    })
    replySequence([
      toolRound('e1', 'edit_file', { path: 'b.txt', edits: [{ old_text: 'two', new_text: '2' }] }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'edit')]).then(drain)
    answerApproval(await pendingApproval(), { approved: true, scope: 'once' })
    const chunks = await draining
    expect(chunks.some((c) => c.type === 'tool-output-error')).toBe(true)
    expect(useChatToolsStore.getState().failures.e1).toBe('changed')
    expect(useChatToolsStore.getState().edits).toEqual({})
  })

  it('says so when an undo finds the file changed, and leaves the edit applied', async () => {
    useChatToolsStore.getState().recordEdit({
      toolCallId: 'e1',
      sessionId: 's1',
      path: '/proj/b.txt',
      root: '/proj',
      existed: true,
      before: 'one two',
      after: 'one 2',
      version: 'v-new',
      outside: false,
      symlink: false,
      auto: true,
      state: 'applied',
      seq: 1,
      decisions: [null],
    })
    vi.mocked(window.ostia.chatTools.restore).mockResolvedValue({
      ok: false,
      error: 'changed',
      path: '/proj/b.txt',
    })
    await undoEdit('e1')
    expect(useChatToolsStore.getState().edits.e1).toMatchObject({
      state: 'applied',
      undoError: 'changed',
    })
  })

  it('sends the question to the model this chat picked', async () => {
    sessionModel = { extId: 'a', provider: 'p2', model: 'big' }
    useAssistStore.setState({
      catalog: {
        models: [
          {
            ref: { extId: 'a', provider: 'p1', model: 'small' },
            group: 'One',
            label: 'small',
            points: ['chat'],
          },
          { ref: sessionModel, group: 'Two', label: 'big', tools: 'prompted', points: ['chat'] },
        ],
        chat: { extId: 'a', provider: 'p1', model: 'small' },
        fast: null,
      },
    })
    replySequence([textRound('hi')])
    const chunks = await drain(await sendWithTools([user('1', 'x')]))
    expect(vi.mocked(window.ostia.assist.request).mock.calls[0][3]).toEqual(sessionModel)
    expect(chunks.find((c) => c.type === 'start')).toMatchObject({
      messageMetadata: { model: 'Two · big' },
    })
    expect(requestAt(0).tools?.length).toBeGreaterThan(0)
  })

  it('asks for an MCP tool once per chat after Allow for this chat', async () => {
    useChatToolsStore.getState().setMcp([
      {
        name: 'fake',
        transport: 'stdio',
        state: 'ready',
        secretsSet: [],
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      },
    ])
    vi.mocked(window.ostia.chatTools.mcpCall).mockResolvedValue({ ok: true, output: 'echo: hi' })
    replySequence([
      toolRound('m1', 'mcp__fake__echo', { text: 'hi' }),
      toolRound('m2', 'mcp__fake__echo', { text: 'again' }),
      textRound('done'),
    ])
    const draining = sendWithTools([user('1', 'echo')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id]).toMatchObject({
      kind: 'mcp',
      grantable: true,
    })
    answerApproval(id, { approved: true, scope: 'chat' })
    const chunks = await draining
    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(1)
    expect(vi.mocked(window.ostia.chatTools.mcpCall).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['fake', 'echo'],
      ['fake', 'echo'],
    ])
  })

  it('asks again in the next chat while main has not stored an Always allow', async () => {
    useChatToolsStore.getState().setMcp([
      {
        name: 'fake',
        transport: 'stdio',
        state: 'ready',
        secretsSet: [],
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      },
    ])
    vi.mocked(window.ostia.chatTools.mcpCall).mockResolvedValue({ ok: true, output: 'echo: hi' })
    vi.mocked(window.ostia.chatTools.grantAlways).mockReturnValueOnce(new Promise(() => {}))
    replySequence([toolRound('m1', 'mcp__fake__echo', { text: 'hi' }), textRound('done')])
    const first = sendWithTools([user('1', 'echo')]).then(drain)
    answerApproval(await pendingApproval(), { approved: true, scope: 'always' })
    await first
    expect(useChatToolsStore.getState().standing).toEqual([])

    replySequence([toolRound('m2', 'mcp__fake__echo', { text: 'again' }), textRound('done')])
    const second = sendWithTools([user('1', 'echo')], undefined, 's2').then(drain)
    answerApproval(await pendingApproval(), { approved: true, scope: 'once' })
    expect((await second).filter((c) => c.type === 'tool-approval-request')).toHaveLength(1)
  })

  it('runs a tool always allowed in one chat unasked in the next, until it is removed', async () => {
    useChatToolsStore.getState().setMcp([
      {
        name: 'fake',
        transport: 'stdio',
        state: 'ready',
        secretsSet: [],
        tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      },
    ])
    vi.mocked(window.ostia.chatTools.mcpCall).mockResolvedValue({ ok: true, output: 'echo: hi' })
    replySequence([toolRound('m1', 'mcp__fake__echo', { text: 'hi' }), textRound('done')])
    const first = sendWithTools([user('1', 'echo')]).then(drain)
    answerApproval(await pendingApproval(), { approved: true, scope: 'always' })
    await first
    expect(window.ostia.chatTools.grantAlways).toHaveBeenCalledWith('mcp__fake__echo')

    replySequence([toolRound('m2', 'mcp__fake__echo', { text: 'again' }), textRound('done')])
    const second = await drain(await sendWithTools([user('1', 'echo')], undefined, 's2'))
    expect(second.filter((c) => c.type === 'tool-approval-request')).toHaveLength(0)
    expect(window.ostia.chatTools.mcpCall).toHaveBeenCalledTimes(2)

    await removeAlwaysGrant('mcp__fake__echo')
    replySequence([toolRound('m3', 'mcp__fake__echo', { text: 'third' }), textRound('done')])
    const third = sendWithTools([user('1', 'echo')], undefined, 's3').then(drain)
    const asked = await pendingApproval()
    expect(useChatToolsStore.getState().pending[asked]).toMatchObject({ kind: 'mcp' })
    answerApproval(asked, { approved: false })
    await third
    expect(window.ostia.chatTools.mcpCall).toHaveBeenCalledTimes(2)
  })

  it('Stop while a card waits closes the stream without running or asking again', async () => {
    vi.mocked(window.ostia.chatTools.preview).mockResolvedValue(
      preview({ exists: false, text: '', version: null }),
    )
    replySequence([toolRound('w1', 'write_file', { path: 'b.txt', content: 'x' }), textRound('no')])
    const abort = new AbortController()
    const draining = sendWithTools([user('1', 'write')], abort.signal).then(drain)
    await pendingApproval()
    abort.abort()
    const chunks = await draining
    expect(useChatToolsStore.getState().pending).toEqual({})
    expect(window.ostia.chatTools.write).not.toHaveBeenCalled()
    expect(window.ostia.assist.request).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'finish')).toBe(false)
  })

  it('reports an unknown tool as failed, and sends no tools once the chat turned them off', async () => {
    replySequence([toolRound('u1', 'rm_rf', {}), textRound('sorry')])
    const chunks = await drain(await sendWithTools([user('1', 'x')]))
    expect(chunks.find((c) => c.type === 'tool-output-error')).toMatchObject({ toolCallId: 'u1' })
    expect(requestAt(1).messages.at(-1)?.tools?.[0]).toMatchObject({ state: 'error' })

    vi.mocked(window.ostia.assist.request).mockClear()
    for (const key of DENY_ALL_BUILTINS) useChatToolsStore.getState().toggle('s1', key, false)
    replySequence([textRound('plain')])
    await drain(await sendWithTools([user('1', 'x')]))
    expect(requestAt(0).tools).toBeUndefined()
  })

  it('sends no tools when the provider does not use them', async () => {
    useAssistStore.setState({
      availability: { chat: { extId: 'a', name: 'A', ref: { extId: 'a' } } },
    })
    replySequence([textRound('plain')])
    await drain(await sendWithTools([user('1', 'x')]))
    expect(requestAt(0).tools).toBeUndefined()
  })
})

describe('toChatRequest with tool parts', () => {
  it('splits an answer into steps, marks unfinished calls as stopped and clips old outputs', () => {
    const long = 'z'.repeat(OLD_TOOL_OUTPUT_MAX + 50)
    const req = toChatRequest([
      user('1', 'first'),
      {
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'Reading.' },
          {
            type: 'dynamic-tool',
            toolName: 'read_file',
            toolCallId: 't1',
            state: 'output-available',
            input: { path: 'a' },
            output: long,
          },
          { type: 'step-start' },
          {
            type: 'dynamic-tool',
            toolName: 'write_file',
            toolCallId: 't2',
            state: 'approval-requested',
            input: { path: 'a', content: 'x' },
            approval: { id: 'ap' },
          },
        ],
      },
      user('3', 'second'),
    ])
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
    expect(req.messages[1]).toMatchObject({
      content: 'Reading.',
      tools: [{ id: 't1', state: 'done' }],
    })
    expect(req.messages[1].tools?.[0].output?.length).toBeLessThan(long.length)
    expect(req.messages[2].tools?.[0]).toMatchObject({
      id: 't2',
      state: 'error',
      error: STOPPED_TOOL_ERROR,
    })
  })
})
