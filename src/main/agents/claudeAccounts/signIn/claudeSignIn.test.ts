import { describe, expect, it, vi } from 'vitest'
import type { CallbackListener } from '../../../chat/mcpOAuth'
import type { OAuthProfile, OAuthTokens, Pkce } from './anthropicOAuth'
import { ClaudeSignIn, type CompleteOutcome } from './claudeSignIn'

const PKCE: Pkce = { verifier: 'v', challenge: 'c', state: 's' }
const TOKENS: OAuthTokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, scopes: [] }
const PROFILE: OAuthProfile = {
  accountUuid: 'u',
  emailAddress: 'me@example.com',
  displayName: null,
  organizationUuid: null,
  organizationName: null,
  subscriptionType: null,
  rateLimitTier: null,
}
const CODE = 'abcdefghijklmnop0123'

function setup(over: { complete?: CompleteOutcome; tokens?: OAuthTokens | null } = {}) {
  let arrive: (code: string) => void = () => {}
  let lapse: (error: Error) => void = () => {}
  const listener: CallbackListener = {
    redirectUrl: 'http://localhost:7/callback',
    result: new Promise((resolve, reject) => {
      arrive = (code) => resolve({ code })
      lapse = reject
    }),
    close: vi.fn(),
  }
  listener.result.catch(() => undefined)
  const deps = {
    listen: vi.fn(async () => listener),
    openExternal: vi.fn(() => true),
    createPkce: () => PKCE,
    exchange: vi.fn(async () => (over.tokens === undefined ? TOKENS : over.tokens)),
    profile: vi.fn(async () => PROFILE),
    complete: vi.fn(async () => over.complete ?? 'done'),
    onChange: vi.fn(),
  }
  return { flow: new ClaudeSignIn(deps), deps, listener, arrive, lapse }
}

describe('ClaudeSignIn', () => {
  it('waits for the browser after begin and opens the authorize page on request', async () => {
    const { flow, deps } = setup()
    expect(await flow.begin(null)).toBe('started')
    expect(flow.status).toBe('waiting')
    expect(deps.listen).toHaveBeenCalledWith({ state: 's', timeoutMs: 600_000 })
    expect(flow.open()).toBe(true)
    const url = new URL((deps.openExternal.mock.calls[0] as unknown as [string])[0])
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:7/callback')
    expect(url.searchParams.get('state')).toBe('s')
  })

  it('does not open a page when no sign-in is waiting', () => {
    const { flow, deps } = setup()
    expect(flow.open()).toBe(false)
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('completes the account from the browser callback and goes idle', async () => {
    const { flow, deps, arrive, listener } = setup()
    await flow.begin('target')
    arrive(CODE)
    await vi.waitFor(() => expect(flow.status).toBe('idle'))
    expect(deps.exchange).toHaveBeenCalledWith(CODE, 'http://localhost:7/callback', PKCE)
    expect(deps.profile).toHaveBeenCalledWith('at')
    expect(deps.complete).toHaveBeenCalledWith('target', TOKENS, PROFILE)
    expect(listener.close).toHaveBeenCalled()
  })

  it('accepts a pasted code once and refuses a second', async () => {
    const { flow, deps } = setup()
    await flow.begin(null)
    expect(flow.submit(CODE)).toBe('accepted')
    expect(flow.submit(CODE)).toBe('idle')
    await vi.waitFor(() => expect(flow.status).toBe('idle'))
    expect(deps.exchange).toHaveBeenCalledTimes(1)
  })

  it.each(['short', `${CODE}#state`, `http://localhost:7/callback?code=${CODE}`, ''])(
    'refuses %j as a code and keeps waiting',
    async (input) => {
      const { flow, deps } = setup()
      await flow.begin(null)
      expect(flow.submit(input)).toBe('invalid')
      expect(flow.status).toBe('waiting')
      expect(deps.exchange).not.toHaveBeenCalled()
    },
  )

  it('refuses a code when nothing is waiting', () => {
    expect(setup().flow.submit(CODE)).toBe('idle')
  })

  it('does not start a second sign-in while one is waiting', async () => {
    const { flow, deps } = setup()
    await flow.begin(null)
    expect(await flow.begin(null)).toBe('busy')
    expect(deps.listen).toHaveBeenCalledTimes(1)
  })

  it('fails when the listener times out and can start again', async () => {
    const { flow, lapse, deps } = setup()
    await flow.begin(null)
    lapse(new Error('timeout'))
    await vi.waitFor(() => expect(flow.status).toBe('failed'))
    deps.listen.mockResolvedValueOnce({
      redirectUrl: 'http://localhost:8/callback',
      result: new Promise(() => {}),
      close: vi.fn(),
    })
    expect(await flow.begin(null)).toBe('started')
    expect(flow.status).toBe('waiting')
    expect(deps.listen).toHaveBeenCalledTimes(2)
  })

  it('fails when the listener cannot open', async () => {
    const { flow, deps } = setup()
    deps.listen.mockRejectedValueOnce(new Error('EADDRINUSE'))
    await flow.begin(null)
    expect(flow.status).toBe('failed')
  })

  it.each([
    ['the exchange gives no tokens', { tokens: null }],
    ['the account is not the one asked for', { complete: 'mismatch' as const }],
    ['the login cannot be written', { complete: 'failed' as const }],
  ])('ends in a failed state when %s', async (_name, over) => {
    const { flow } = setup(over)
    await flow.begin(null)
    flow.submit(CODE)
    await vi.waitFor(() => expect(flow.status).not.toBe('waiting'))
    await vi.waitFor(() => expect(['failed', 'mismatch']).toContain(flow.status))
  })

  it('reports a mismatch as its own status', async () => {
    const { flow } = setup({ complete: 'mismatch' })
    await flow.begin('x')
    flow.submit(CODE)
    await vi.waitFor(() => expect(flow.status).toBe('mismatch'))
  })

  it('cancel closes the listener and ignores a later callback', async () => {
    const { flow, deps, arrive, listener } = setup()
    await flow.begin(null)
    flow.cancel()
    expect(flow.status).toBe('idle')
    expect(listener.close).toHaveBeenCalled()
    arrive(CODE)
    await Promise.resolve()
    expect(deps.exchange).not.toHaveBeenCalled()
  })

  it('cannot be cancelled while the account is being written', async () => {
    const { flow, deps } = setup()
    let release: (outcome: CompleteOutcome) => void = () => {}
    deps.complete.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    await flow.begin(null)
    flow.submit(CODE)
    await vi.waitFor(() => expect(deps.complete).toHaveBeenCalled())
    flow.cancel()
    expect(flow.status).toBe('working')
    release('done')
    await vi.waitFor(() => expect(flow.status).toBe('idle'))
  })
})
