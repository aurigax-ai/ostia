import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchProfile,
  type Pkce,
  parseCode,
} from './anthropicOAuth'

const PKCE: Pkce = { verifier: 'verifier', challenge: 'challenge', state: 'state' }
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

describe('createPkce', () => {
  it('binds the challenge to the verifier with S256 and never repeats', () => {
    const a = createPkce()
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
    expect(createPkce().state).not.toBe(a.state)
  })
})

describe('authorizeUrl', () => {
  it('asks for a code with the challenge, state and loopback redirect', () => {
    const url = new URL(authorizeUrl('http://localhost:5000/callback', PKCE))
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5000/callback')
    expect(url.searchParams.get('code_challenge')).toBe('challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })
})

describe('parseCode', () => {
  const CODE = 'abcDEF0123456789_-xyz'

  it('accepts a bare code, code#state and the localhost callback address', () => {
    expect(parseCode(`  ${CODE}  `, 'state')).toBe(CODE)
    expect(parseCode(`${CODE}#state`, 'state')).toBe(CODE)
    expect(parseCode(`http://localhost:5000/callback?code=${CODE}&state=state`, 'state')).toBe(CODE)
    expect(parseCode(`http://127.0.0.1:5000/callback?code=${CODE}`, 'state')).toBe(CODE)
  })

  it("refuses a state that is not this sign-in's, however it came", () => {
    expect(parseCode(`${CODE}#other`, 'state')).toBeNull()
    expect(parseCode(`${CODE}#`, 'state')).toBeNull()
    expect(parseCode(`http://localhost:5000/callback?code=${CODE}&state=other`, 'state')).toBeNull()
  })

  it.each([
    'short',
    '',
    'a'.repeat(513),
    'abc def0123456789xyz',
    'https://localhost:5000/callback?code=abcDEF0123456789_-xyz',
    'http://evil.example/callback?code=abcDEF0123456789_-xyz',
    'http://localhost:5000/other?code=abcDEF0123456789_-xyz',
    'http://localhost:5000/callback',
  ])('refuses %j', (input) => {
    expect(parseCode(input, 'state')).toBeNull()
  })
})

describe('exchangeCode', () => {
  it('posts the code with the verifier and returns the tokens with a computed expiry', async () => {
    const request = vi.fn(async () =>
      json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 100,
        scope: 'user:profile user:inference',
      }),
    )
    const tokens = await exchangeCode('code', 'http://localhost:1/callback', PKCE, 1000, request)
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 101_000,
      scopes: ['user:profile', 'user:inference'],
    })
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: 'http://localhost:1/callback',
    })
  })

  it.each([
    ['an error status', () => json({ error: 'bad' }, 400)],
    ['a body without a refresh token', () => json({ access_token: 'at', expires_in: 100 })],
    ['a body without an access token', () => json({ refresh_token: 'rt', expires_in: 100 })],
    ['a body without an expiry', () => json({ access_token: 'at', refresh_token: 'rt' })],
    [
      'an expiry that is not a positive number',
      () => json({ access_token: 'at', refresh_token: 'rt', expires_in: '100' }),
    ],
    [
      'a token over 4 KiB',
      () => json({ access_token: 'a'.repeat(4097), refresh_token: 'rt', expires_in: 100 }),
    ],
    [
      'a token with a space or control character',
      () => json({ access_token: 'a b', refresh_token: 'r\nt', expires_in: 100 }),
    ],
    [
      'a scope that was not asked for',
      () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 100, scope: 'admin:all' }),
    ],
    ['a body over 64 KiB', () => new Response(`{"pad":"${'x'.repeat(70_000)}"}`)],
    ['an unreadable body', () => new Response('nope')],
  ])('returns nothing for %s', async (_name, response) => {
    expect(await exchangeCode('c', 'r', PKCE, 0, async () => response())).toBeNull()
  })

  it.each([
    [1, 60],
    [10 ** 9, 365 * 24 * 3600],
  ])('clamps an expiry of %i seconds to %i', async (seconds, clamped) => {
    const tokens = await exchangeCode('c', 'r', PKCE, 0, async () =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: seconds }),
    )
    expect(tokens?.expiresAt).toBe(clamped * 1000)
  })

  it('returns nothing when the request fails', async () => {
    const failing = async (): Promise<Response> => {
      throw new Error('offline')
    }
    expect(await exchangeCode('c', 'r', PKCE, 0, failing)).toBeNull()
  })
})

describe('fetchProfile', () => {
  it('reads the account, organization and plan', async () => {
    const request = vi.fn(async () =>
      json({
        account: { uuid: 'u', email: 'me@example.com', display_name: 'Me' },
        organization: {
          uuid: 'o',
          name: 'Org',
          organization_type: 'claude_max',
          rate_limit_tier: 'tier',
        },
      }),
    )
    expect(await fetchProfile('token', request)).toEqual({
      accountUuid: 'u',
      emailAddress: 'me@example.com',
      displayName: 'Me',
      organizationUuid: 'o',
      organizationName: 'Org',
      subscriptionType: 'max',
      rateLimitTier: 'tier',
    })
    const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toEqual({ authorization: 'Bearer token' })
    expect(init.redirect).toBe('error')
  })

  it('returns nothing for a body over 64 KiB', async () => {
    const big = new Response(`{"pad":"${'x'.repeat(70_000)}"}`)
    expect(await fetchProfile('t', async () => big)).toBeNull()
  })

  it('returns nothing without an email', async () => {
    expect(await fetchProfile('t', async () => json({ account: { uuid: 'u' } }))).toBeNull()
    expect(await fetchProfile('t', async () => json({}, 401))).toBeNull()
  })
})
