import type { AssistChunk } from '@shared/assist'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assistRequest } from './assistStore'

afterEach(() => {
  vi.mocked(window.pine.assist.request).mockReset()
})

describe('assistRequest', () => {
  it('waits for streamed chunks that arrive after the reply', async () => {
    const listeners = new Set<(c: AssistChunk) => void>()
    vi.mocked(window.pine.assist.onChunk).mockImplementation((cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    })
    vi.mocked(window.pine.assist.request).mockImplementation(async (_point, requestId) => {
      setTimeout(() => {
        for (const text of ['a', 'b']) for (const cb of listeners) cb({ requestId, text })
      }, 20)
      return { ok: true, result: { text: 'ab' }, chunks: 2 } as never
    })
    const seen: string[] = []
    await assistRequest(
      'chat',
      { messages: [{ role: 'user', content: 'x' }], context: [] },
      { onChunk: (text) => seen.push(text) },
    )
    expect(seen).toEqual(['a', 'b'])
  })
})
