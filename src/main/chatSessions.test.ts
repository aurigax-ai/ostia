import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatSession, ChatSessionMessage } from '../shared/chatSessions'
import { createChatSessionStore } from './chatSessions'

function msg(i: number, role: 'user' | 'assistant', text: string): ChatSessionMessage {
  return { id: `m${i}`, role, parts: [{ type: 'text', text }], metadata: { createdAt: i } }
}

function session(id: string, updatedAt: number, messages: ChatSessionMessage[]): ChatSession {
  return {
    id,
    workspaceId: 'w1',
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt,
    model: 'fake · big',
    messageCount: messages.length,
    messages,
  }
}

describe('createChatSessionStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-chat-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('saves a session privately and lists it newest first without messages', () => {
    const store = createChatSessionStore({ dir })
    store.save(session('a', 10, [msg(1, 'user', 'hi'), msg(2, 'assistant', 'hello')]))
    store.save(session('b', 20, [msg(1, 'user', 'yo')]))
    expect(store.list().map((s) => [s.id, s.messageCount])).toEqual([
      ['b', 1],
      ['a', 2],
    ])
    expect(store.list()[0]).not.toHaveProperty('messages')
    expect(store.get('a')?.messages.map((m) => m.parts[0].text)).toEqual(['hi', 'hello'])
    expect(statSync(join(dir, 'a.json')).mode & 0o777).toBe(0o600)
  })

  it('keeps future part types such as tool calls intact', () => {
    const store = createChatSessionStore({ dir })
    const tool = { type: 'tool-ls', toolCallId: 't1', state: 'output-available', output: { n: 1 } }
    store.save(
      session('a', 1, [
        msg(1, 'user', 'list'),
        { id: 'm2', role: 'assistant', parts: [tool, { type: 'text', text: 'done' }] },
      ]),
    )
    expect(store.get('a')?.messages[1].parts).toEqual([tool, { type: 'text', text: 'done' }])
  })

  it('trims the oldest turns of a session over its cap and marks it trimmed', () => {
    const store = createChatSessionStore({ dir, sessionMaxBytes: 2000 })
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg(i, i % 2 === 0 ? 'user' : 'assistant', `${i}-${'x'.repeat(300)}`),
    )
    const res = store.save(session('a', 1, messages))
    expect(res.ok && res.trimmedMessages).toBeGreaterThan(0)
    const saved = store.get('a')
    expect(saved?.trimmed).toBe(true)
    expect(saved?.messages[0].role).toBe('user')
    expect(saved?.messages.at(-1)?.id).toBe('m9')
    expect(readFileSync(join(dir, 'a.json')).length).toBeLessThanOrEqual(2000)
  })

  it('evicts the least recently updated sessions over the total cap, never the one saved', () => {
    const store = createChatSessionStore({ dir, maxSessions: 2 })
    store.save(session('old', 1, [msg(1, 'user', 'a')]))
    store.save(session('mid', 2, [msg(1, 'user', 'b')]))
    const res = store.save(session('new', 0, [msg(1, 'user', 'c')]))
    expect(res.ok && res.evicted).toEqual(['old'])
    expect(
      store
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['mid', 'new'])
  })

  it('renames, deletes and refuses ids that could escape the folder', () => {
    const store = createChatSessionStore({ dir })
    store.save(session('a', 1, [msg(1, 'user', 'hi')]))
    expect(store.rename('a', '  Deploy   notes ')?.title).toBe('Deploy notes')
    expect(store.rename('a', '   ')).toBeNull()
    expect(store.save({ ...session('a', 1, []), id: '../x' })).toEqual({
      ok: false,
      error: 'invalid-session',
    })
    expect(store.get('../a')).toBeNull()
    expect(store.remove('a')).toBe(true)
    expect(store.remove('a')).toBe(false)
    expect(store.list()).toEqual([])
  })
})
