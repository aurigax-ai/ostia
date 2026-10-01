import { describe, expect, it } from 'vitest'
import { baseUrl, errorMessage, parseEndpoint } from './endpoint'

describe('parseEndpoint', () => {
  it('reads http and https URLs with their base path', () => {
    expect(parseEndpoint('http://127.0.0.1:11434/v1/')).toEqual({
      origin: 'http://127.0.0.1:11434',
      basePath: '/v1',
    })
    expect(parseEndpoint('https://openrouter.ai/api/v1')?.origin).toBe('https://openrouter.ai')
  })

  it('reads unix socket addresses and gives them a placeholder origin', () => {
    const socket = parseEndpoint('unix:/run/user/1000/model-runtime.sock')
    expect(socket).toEqual({
      socketPath: '/run/user/1000/model-runtime.sock',
      origin: 'http://localhost',
      basePath: '',
    })
    expect(socket && baseUrl(socket, '/v1')).toBe('http://localhost/v1')
  })

  it('refuses relative sockets, other schemes and URLs with credentials', () => {
    expect(parseEndpoint('unix:relative.sock')).toBeNull()
    expect(parseEndpoint('file:///etc/passwd')).toBeNull()
    expect(parseEndpoint('https://user:secret@example.com/v1')).toBeNull()
    expect(parseEndpoint('not a url')).toBeNull()
  })
})

describe('errorMessage', () => {
  it('prefers the provider error message from a JSON body', () => {
    expect(errorMessage(404, '{"error":"unknown model gemma9"}')).toBe(
      'HTTP 404: unknown model gemma9',
    )
    expect(errorMessage(500, '{"error":{"message":"boom"}}')).toBe('HTTP 500: boom')
    expect(errorMessage(502, '')).toBe('HTTP 502')
  })
})
