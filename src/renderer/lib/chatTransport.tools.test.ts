import {
  type AssistChunk,
  type AssistModelRef,
  type ChatAssistRequest,
  EMPTY_ASSIST_CATALOG,
} from '@shared/assist'
import type { UIMessageChunk } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { answerApproval, resetChatTools, useChatToolsStore } from '../stores/chatToolsStore'
import {
  OLD_TOOL_OUTPUT_MAX,
  type PineChatMessage,
  STOPPED_TOOL_ERROR,
  createAssistTransport,
  toChatRequest,
} from './chatTransport'

function user(id: string, text: string): PineChatMessage {
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
  vi.mocked(window.pine.assist.onChunk).mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  let round = 0
  vi.mocked(window.pine.assist.request).mockImplementation(async (_point, requestId) => {
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

function sendWithTools(messages: PineChatMessage[], abortSignal?: AbortSignal) {
  return createAssistTransport({
    sessionId: 's1',
    workspaceId: () => null,
    root: () => '/proj',
    model: () => sessionModel,
  }).sendMessages({
    trigger: 'submit-message',
    chatId: 's1',
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

function requestAt(n: number): ChatAssistRequest {
  return vi.mocked(window.pine.assist.request).mock.calls[n][2] as ChatAssistRequest
}

const DENY_ALL_BUILTINS = [
  'read_file',
  'list_directory',
  'search_files',
  'terminal_context',
  'propose_command',
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
    vi.mocked(window.pine.assist.request).mockReset()
    vi.mocked(window.pine.chatTools.read).mockReset()
    vi.mocked(window.pine.chatTools.preview).mockReset()
    vi.mocked(window.pine.chatTools.write).mockReset()
    vi.mocked(window.pine.chatTools.mcpCall).mockReset()
    sessionModel = null
    useAssistStore.setState({ availability: {}, catalog: EMPTY_ASSIST_CATALOG })
    resetChatTools()
  })

  it('offers the tools, runs a read-only tool without asking and sends its result back', async () => {
    vi.mocked(window.pine.chatTools.read).mockResolvedValue({
      ok: true,
      path: '/proj/a.txt',
      text: 'hi',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    })
    replySequence([toolRound('t1', 'read_file', { path: 'a.txt' }), textRound('It says hi')])
    const chunks = await drain(await sendWithTools([user('1', 'what is in a.txt')]))
    expect(requestAt(0).tools?.map((t) => t.name)).toContain('read_file')
    expect(vi.mocked(window.pine.chatTools.read).mock.calls[0][0]).toMatchObject({
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
    expect(chunks.filter((c) => c.type === 'start')).toHaveLength(1)
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('asks before reading outside the workspace folder', async () => {
    vi.mocked(window.pine.chatTools.read)
      .mockResolvedValueOnce({ ok: false, error: 'outside-folder', path: '/etc/hosts' })
      .mockResolvedValueOnce({
        ok: true,
        path: '/etc/hosts',
        text: 'x',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
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
    expect(vi.mocked(window.pine.chatTools.read).mock.calls[1][0]).toMatchObject({
      outside: true,
    })
  })

  it('asks before writing; Deny records a denied call and writes nothing', async () => {
    vi.mocked(window.pine.chatTools.preview).mockResolvedValue({
      ok: true,
      path: '/proj/b.txt',
      exists: true,
      text: 'old',
    })
    replySequence([
      toolRound('w1', 'write_file', { path: 'b.txt', content: 'new' }),
      textRound('ok'),
    ])
    const draining = sendWithTools([user('1', 'change b')]).then(drain)
    const id = await pendingApproval()
    expect(useChatToolsStore.getState().pending[id]).toMatchObject({
      kind: 'write',
      grantable: false,
      detail: { path: '/proj/b.txt', before: 'old', after: 'new' },
    })
    answerApproval(id, { approved: false })
    const chunks = await draining
    expect(window.pine.chatTools.write).not.toHaveBeenCalled()
    expect(chunks.map((c) => c.type)).toEqual(
      expect.arrayContaining([
        'tool-approval-request',
        'tool-approval-response',
        'tool-output-denied',
      ]),
    )
    expect(requestAt(1).messages.at(-1)?.tools?.[0]).toMatchObject({ state: 'denied' })
  })

  it('writes after Allow once, and asks again for the next write', async () => {
    vi.mocked(window.pine.chatTools.preview).mockResolvedValue({
      ok: true,
      path: '/proj/b.txt',
      exists: false,
      text: '',
    })
    vi.mocked(window.pine.chatTools.write).mockResolvedValue({
      ok: true,
      path: '/proj/b.txt',
      created: true,
      bytes: 3,
    })
    replySequence([
      toolRound('w1', 'write_file', { path: 'b.txt', content: 'new' }),
      toolRound('w2', 'write_file', { path: 'b.txt', content: 'again' }),
      textRound('done'),
    ])
    const draining = sendWithTools([user('1', 'write b')]).then(drain)
    answerApproval(await pendingApproval(), { approved: true, scope: 'once' })
    answerApproval(await pendingApproval(), { approved: false })
    const chunks = await draining
    expect(window.pine.chatTools.write).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.pine.chatTools.write).mock.calls[0][0]).toMatchObject({
      path: '/proj/b.txt',
      content: 'new',
    })
    expect(chunks.filter((c) => c.type === 'tool-approval-request')).toHaveLength(2)
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
    expect(vi.mocked(window.pine.assist.request).mock.calls[0][3]).toEqual(sessionModel)
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
    vi.mocked(window.pine.chatTools.mcpCall).mockResolvedValue({ ok: true, output: 'echo: hi' })
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
    expect(vi.mocked(window.pine.chatTools.mcpCall).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['fake', 'echo'],
      ['fake', 'echo'],
    ])
  })

  it('Stop while a card waits closes the stream without running or asking again', async () => {
    vi.mocked(window.pine.chatTools.preview).mockResolvedValue({
      ok: true,
      path: '/proj/b.txt',
      exists: false,
      text: '',
    })
    replySequence([toolRound('w1', 'write_file', { path: 'b.txt', content: 'x' }), textRound('no')])
    const abort = new AbortController()
    const draining = sendWithTools([user('1', 'write')], abort.signal).then(drain)
    await pendingApproval()
    abort.abort()
    const chunks = await draining
    expect(useChatToolsStore.getState().pending).toEqual({})
    expect(window.pine.chatTools.write).not.toHaveBeenCalled()
    expect(window.pine.assist.request).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'finish')).toBe(false)
  })

  it('reports an unknown tool as failed, and sends no tools once the chat turned them off', async () => {
    replySequence([toolRound('u1', 'rm_rf', {}), textRound('sorry')])
    const chunks = await drain(await sendWithTools([user('1', 'x')]))
    expect(chunks.find((c) => c.type === 'tool-output-error')).toMatchObject({ toolCallId: 'u1' })
    expect(requestAt(1).messages.at(-1)?.tools?.[0]).toMatchObject({ state: 'error' })

    vi.mocked(window.pine.assist.request).mockClear()
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
