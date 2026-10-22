import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchProfile,
  type Pkce,
  validCode,
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

describe('validCode', () => {
  it('accepts only a bare code', () => {
    expect(validCode('  abcDEF0123456789_-xyz  ')).toBe('abcDEF0123456789_-xyz')
    expect(validCode('abcDEF0123456789#state')).toBeNull()
    expect(validCode('http://localhost:5000/callback?code=abcDEF0123456789')).toBeNull()
    expect(validCode('short')).toBeNull()
    expect(validCode('')).toBeNull()
    expect(validCode('a'.repeat(513))).toBeNull()
  })
})

describe('exchangeCode', () => {
  it('posts the code with the verifier and returns the tokens with a computed expiry', async () => {
    const request = vi.fn(async () =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 100, scope: 'a b' }),
    )
    const tokens = await exchangeCode('code', 'http://localhost:1/callback', PKCE, 1000, request)
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 101_000,
      scopes: ['a', 'b'],
    })
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    expect(JSON.parse(String(init.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: 'http://localhost:1/callback',
    })
  })

  it.each([
    ['an error status', () => json({ error: 'bad' }, 400)],
    ['a body without a refresh token', () => json({ access_token: 'at' })],
    ['a body without an access token', () => json({ refresh_token: 'rt' })],
    ['an unreadable body', () => new Response('nope')],
  ])('returns nothing for %s', async (_name, response) => {
    expect(await exchangeCode('c', 'r', PKCE, 0, async () => response())).toBeNull()
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
  })

  it('returns nothing without an email', async () => {
    expect(await fetchProfile('t', async () => json({ account: { uuid: 'u' } }))).toBeNull()
    expect(await fetchProfile('t', async () => json({}, 401))).toBeNull()
  })
})
