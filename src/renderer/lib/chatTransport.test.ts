import type { AssistChunk } from '@shared/assist'
import type { UIMessageChunk } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import {
  type OstiaChatMessage,
  createAssistTransport,
  decodeChatError,
  toChatRequest,
} from './chatTransport'

function user(id: string, text: string, context?: OstiaChatMessage['metadata']): OstiaChatMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...(context ? { metadata: context } : {}),
  }
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

function replyWith(chunks: string[], result: unknown): void {
  const listeners = new Set<(c: AssistChunk) => void>()
  vi.mocked(window.ostia.assist.onChunk).mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  vi.mocked(window.ostia.assist.request).mockImplementation(async (_point, requestId) => {
    for (const text of chunks) for (const cb of listeners) cb({ requestId, text })
    return result as never
  })
}

const send = (messages: OstiaChatMessage[]) =>
  createAssistTransport().sendMessages({
    trigger: 'submit-message',
    chatId: 'c1',
    messageId: undefined,
    messages,
    abortSignal: undefined,
  })

describe('toChatRequest', () => {
  it('sends text turns and the newest context once per chip, skipping failed answers', () => {
    const req = toChatRequest([
      user('1', 'first', { context: [{ kind: 'cwd', label: 'Folder', text: '/a' }] }),
      {
        id: '2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'oops' }],
        metadata: { error: 'x' },
      },
      user('3', 'second', { context: [{ kind: 'cwd', label: 'Folder', text: '/b' }] }),
    ])
    expect(req.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ])
    expect(req.context).toEqual([{ kind: 'cwd', label: 'Folder', text: '/b' }])
  })
})

describe('createAssistTransport', () => {
  afterEach(() => {
    vi.mocked(window.ostia.assist.request).mockReset()
    useAssistStore.setState({ availability: {} })
  })

  it('passes the extension UI chunks through and stamps the model on the start chunk', async () => {
    useAssistStore.setState({
      availability: { chat: { extId: 'a', name: 'A', label: 'fake · big', ref: { extId: 'a' } } },
    })
    replyWith(
      [
        JSON.stringify({ type: 'start' }),
        JSON.stringify({ type: 'text-start', id: 't' }),
        JSON.stringify({ type: 'text-delta', id: 't', delta: 'Hi' }),
        JSON.stringify({ type: 'text-end', id: 't' }),
        JSON.stringify({ type: 'finish' }),
      ],
      { ok: true, result: { text: 'Hi' } },
    )
    const chunks = await drain(await send([user('1', 'hello')]))
    expect(chunks.map((c) => c.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(chunks[0]).toMatchObject({ messageMetadata: { model: 'fake · big' } })
    expect(vi.mocked(window.ostia.assist.request).mock.calls[0][2]).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
      context: [],
    })
  })

  it('turns plain text deltas and a final text into one streamed text part', async () => {
    replyWith(['Use ', 'ls'], { ok: true, result: { text: 'Use ls' } })
    const chunks = await drain(await send([user('1', 'list')]))
    expect(
      chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta),
    ).toEqual(['Use ', 'ls'])
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('reports a failure as an error chunk the view can name, and a cancel as nothing', async () => {
    replyWith([], { ok: false, error: 'rate-limited', message: 'slow down' })
    const failed = await drain(await send([user('1', 'x')]))
    const error = failed.find((c) => c.type === 'error') as { errorText: string }
    expect(decodeChatError(error.errorText)).toEqual({ code: 'rate-limited', message: 'slow down' })

    replyWith([], { ok: false, error: 'cancelled' })
    expect((await drain(await send([user('1', 'x')]))).some((c) => c.type === 'error')).toBe(false)
  })
})
