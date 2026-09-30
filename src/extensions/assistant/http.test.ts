import { describe, expect, it } from 'vitest'
import { type SseEvent, createSseParser, errorMessage, parseEndpoint } from './http'

describe('parseEndpoint', () => {
  it('reads http and https URLs with their base path', () => {
    expect(parseEndpoint('http://127.0.0.1:11434/v1/')).toEqual({
      origin: 'http://127.0.0.1:11434',
      basePath: '/v1',
      secure: false,
    })
    expect(parseEndpoint('https://openrouter.ai/api/v1')?.secure).toBe(true)
  })

  it('reads unix socket addresses', () => {
    expect(parseEndpoint('unix:/run/user/1000/model-runtime.sock')).toEqual({
      socketPath: '/run/user/1000/model-runtime.sock',
      basePath: '',
      secure: false,
    })
  })

  it('refuses relative sockets, other schemes and URLs with credentials', () => {
    expect(parseEndpoint('unix:relative.sock')).toBeNull()
    expect(parseEndpoint('file:///etc/passwd')).toBeNull()
    expect(parseEndpoint('https://user:secret@example.com/v1')).toBeNull()
    expect(parseEndpoint('not a url')).toBeNull()
  })
})

describe('createSseParser', () => {
  it('joins events split across chunks and skips comments', () => {
    const events: SseEvent[] = []
    const feed = createSseParser((e) => events.push(e))
    feed(': keep-alive\n\ndata: {"a"')
    feed(':1}\n\nevent: content_block_delta\r\ndata: x\r\n\r\n')
    feed('data: one\ndata: two\n\n')
    expect(events).toEqual([
      { data: '{"a":1}' },
      { event: 'content_block_delta', data: 'x' },
      { data: 'one\ntwo' },
    ])
  })
})

describe('errorMessage', () => {
  it('prefers the provider error message from a JSON body', () => {
    expect(errorMessage(401, '{"error":{"message":"bad key"}}')).toBe('HTTP 401: bad key')
    expect(errorMessage(500, '{"error":"streaming isn\'t supported"}')).toBe(
      "HTTP 500: streaming isn't supported",
    )
    expect(errorMessage(502, '')).toBe('HTTP 502')
  })
})
