import { describe, expect, it } from 'vitest'
import { envName } from '../../shared/appEnv'
import { en } from '../../shared/dict'
import {
  MCP_OAUTH_BROWSER_ENV,
  SignInFailure,
  mcpOAuthBrowser,
  openCallbackListener,
} from './mcpOAuth'

const pages = en.native.signIn

async function listen(timeoutMs = 5_000) {
  return openCallbackListener({ state: 'expected-state', timeoutMs, pages })
}

function callback(redirectUrl: string, params: Record<string, string>): URL {
  const url = new URL(redirectUrl)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url
}

describe('mcpOAuthBrowser', () => {
  it('lets the fetch browser stand in only for an unpackaged app that asks for it', () => {
    const name = envName(MCP_OAUTH_BROWSER_ENV)
    expect(mcpOAuthBrowser(false, { [name]: 'fetch' })).toBe('fetch')
    expect(mcpOAuthBrowser(true, { [name]: 'fetch' })).toBe('system')
    expect(mcpOAuthBrowser(false, {})).toBe('system')
    expect(mcpOAuthBrowser(false, { [name]: '1' })).toBe('system')
    expect(mcpOAuthBrowser(false, { PINE_MCP_OAUTH_BROWSER: 'fetch' })).toBe('system')
  })
})

describe('openCallbackListener', () => {
  it('listens on a loopback port of its own and hands over the code sent with its state', async () => {
    const listener = await listen()
    const other = await listen()
    try {
      expect(listener.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
      expect(other.redirectUrl).not.toBe(listener.redirectUrl)
      const res = await fetch(
        callback(listener.redirectUrl, { code: 'c-1', state: 'expected-state', iss: 'https://as' }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(await res.text()).toContain(pages.done)
      expect(await listener.result).toEqual({ code: 'c-1', issuer: 'https://as' })
    } finally {
      listener.close()
      other.close()
    }
  })

  it('refuses a wrong state, path, method or host and keeps waiting', async () => {
    const listener = await listen()
    try {
      const good = { code: 'c-1', state: 'expected-state' }
      expect(
        (await fetch(callback(listener.redirectUrl, { code: 'x', state: 'nope' }))).status,
      ).toBe(400)
      expect((await fetch(callback(listener.redirectUrl, { code: 'x' }))).status).toBe(400)
      expect(
        (await fetch(new URL('/other?code=x&state=expected-state', listener.redirectUrl))).status,
      ).toBe(404)
      expect((await fetch(callback(listener.redirectUrl, good), { method: 'POST' })).status).toBe(
        404,
      )
      const viaName = callback(listener.redirectUrl.replace('127.0.0.1', 'localhost'), good)
      const named = await fetch(viaName).catch(() => null)
      expect(named === null || named.status === 404).toBe(true)
      let settled = false
      void listener.result.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await new Promise((r) => setTimeout(r, 50))
      expect(settled).toBe(false)
      expect((await fetch(callback(listener.redirectUrl, good))).status).toBe(200)
      expect(await listener.result).toEqual({ code: 'c-1', issuer: undefined })
    } finally {
      listener.close()
    }
  })

  it('fails with the reason the authorization server gave', async () => {
    const listener = await listen()
    try {
      const res = await fetch(
        callback(listener.redirectUrl, {
          state: 'expected-state',
          error: 'access_denied',
          error_description: 'Nope',
        }),
      )
      expect(res.status).toBe(400)
      await expect(listener.result).rejects.toMatchObject({
        code: 'failed',
        detail: 'access_denied: Nope',
      })
    } finally {
      listener.close()
    }
  })

  it('gives up after its timeout and stops listening once closed', async () => {
    const listener = await listen(60)
    await expect(listener.result).rejects.toBeInstanceOf(SignInFailure)
    await expect(listener.result).rejects.toMatchObject({ code: 'timeout' })
    listener.close()
    await expect(fetch(listener.redirectUrl)).rejects.toThrow()

    const closed = await listen()
    closed.close()
    await expect(closed.result).rejects.toMatchObject({ code: 'cancelled' })
  })
})
