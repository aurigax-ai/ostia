import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountsState } from '../../../shared/claudeAccounts/claudeAccounts'
import { type CallbackListener, openCallbackListener } from '../../chat/mcpOAuth'
import { loginState, writeLogin } from './accountProfiles'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts, type ClaudeAccountsDeps } from './claudeAccounts'
import type { OAuthProfile, OAuthTokens } from './signIn/anthropicOAuth'

const WORK = 'a'.repeat(16)
const CODE = 'abcdefghijklmnop0123'
const TOKENS: OAuthTokens = {
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: 9,
  scopes: [],
}

let base: string
let root: string
let store: ClaudeAccountsStore
let accounts: ClaudeAccounts
let published: ClaudeAccountsState[]
let profile: OAuthProfile
let signedOut: Set<string>
let writes: string[]
let writeOk: boolean
let listener: CallbackListener

const profileOf = (email: string): OAuthProfile => ({
  accountUuid: 'uuid',
  emailAddress: email,
  displayName: null,
  organizationUuid: null,
  organizationName: null,
  subscriptionType: null,
  rateLimitTier: null,
})

function signInDeps(): NonNullable<ClaudeAccountsDeps['signIn']> {
  return {
    listen: async () => listener,
    openExternal: () => true,
    createPkce: () => ({ verifier: 'v', challenge: 'c', state: 's' }),
    exchange: async () => TOKENS,
    profile: async () => profile,
  }
}

function deps(over: Partial<ClaudeAccountsDeps> = {}): ClaudeAccountsDeps {
  return {
    store,
    usage: null,
    root,
    defaultHome: () => join(base, 'home'),
    defaultLogin: async () => ({ uuid: null, email: 'me@example.com' }),
    profileLogin: async () => null,
    loginState: async (dir) => (signedOut.has(dir) ? 'signed-out' : 'signed-in'),
    writeLogin: async (dir) => {
      writes.push(dir)
      return writeOk
    },
    signIn: signInDeps(),
    syncProfile: async () => {},
    agentRunning: () => false,
    paneOf: (id) => id,
    openLoginTab: async () => 'login-pane',
    onChange: (state) => published.push(state),
    ...over,
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-signin-'))
  root = join(base, 'claude-accounts')
  mkdirSync(join(base, 'home'))
  store = new ClaudeAccountsStore(join(base, 'accounts.json'))
  published = []
  profile = profileOf('work@example.com')
  signedOut = new Set()
  writes = []
  writeOk = true
  listener = {
    redirectUrl: 'http://localhost:9/callback',
    result: new Promise(() => {}),
    close: vi.fn(),
  }
  accounts = new ClaudeAccounts(deps())
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

async function signIn(target: string | null): Promise<void> {
  expect(await accounts.beginSignIn(target)).toBe('started')
  expect(accounts.submitSignIn(CODE)).toBe('accepted')
  await vi.waitFor(async () => expect((await accounts.state()).signIn).not.toBe('working'))
}

describe('state', () => {
  it('offers sign-in only where the service has it', async () => {
    expect((await accounts.state()).signInAvailable).toBe(true)
    expect((await accounts.state()).signIn).toBe('idle')
  })

  it('marks a listed account whose login can no longer refresh as signed out', async () => {
    store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
    signedOut.add(join(root, WORK))
    expect((await accounts.state()).accounts.map((a) => [a.email, a.signedOut])).toEqual([
      ['me@example.com', false],
      ['work@example.com', true],
    ])
  })
})

describe('signing in a new account', () => {
  it('makes the profile, writes the login into it and lists the account', async () => {
    await signIn(null)
    const [added] = store.accounts()
    expect(added.email).toBe('work@example.com')
    expect(writes).toEqual([join(root, added.id)])
    expect(existsSync(join(root, added.id, '.ostia-pending'))).toBe(false)
    expect((await accounts.state()).accounts.map((a) => a.email)).toContain('work@example.com')
    expect(published.at(-1)?.signIn).toBe('idle')
  })

  it('makes no profile folder before a login came back', async () => {
    await accounts.beginSignIn(null)
    expect(existsSync(root)).toBe(false)
  })

  it('says the account is already added instead of making a second profile', async () => {
    profile = profileOf('ME@example.com')
    await signIn(null)
    expect(store.accounts()).toEqual([])
    expect(existsSync(root)).toBe(false)
    expect((await accounts.state()).duplicate).toBe('default')
  })

  it('refuses a login whose id is the default account’s even under another address', async () => {
    accounts = new ClaudeAccounts(
      deps({ defaultLogin: async () => ({ uuid: 'uuid', email: 'old@example.com' }) }),
    )
    profile = profileOf('new@example.com')
    await signIn(null)
    expect(store.accounts()).toEqual([])
    expect((await accounts.state()).duplicate).toBe('default')
  })

  it('removes the new profile and lists nothing when the login cannot be written', async () => {
    writeOk = false
    await signIn(null)
    expect(store.accounts()).toEqual([])
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
    expect((await accounts.state()).signIn).toBe('failed')
  })

  it('refuses while the account list is damaged', async () => {
    const file = join(base, 'damaged.json')
    writeFileSync(file, 'not json')
    store = new ClaudeAccountsStore(file)
    accounts = new ClaudeAccounts(deps())
    expect(await accounts.beginSignIn(null)).toBe('damaged')
  })

  it('does not start while a terminal login is waiting', async () => {
    await accounts.add({ workspaceId: 'w', windowId: '1' })
    expect(await accounts.beginSignIn(null)).toBe('busy')
  })
})

describe('signing in again', () => {
  beforeEach(() => {
    store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  })

  it('writes the login into the account the human clicked on', async () => {
    await signIn(WORK)
    expect(writes).toEqual([join(root, WORK)])
    expect(store.accounts()).toHaveLength(1)
    expect((await accounts.state()).signIn).toBe('idle')
  })

  it('refuses a login for a different account and writes nothing', async () => {
    profile = profileOf('other@example.com')
    await signIn(WORK)
    expect(writes).toEqual([])
    expect((await accounts.state()).signIn).toBe('mismatch')
  })

  it('knows no account it does not list', async () => {
    expect(await accounts.beginSignIn('b'.repeat(16))).toBe('unknown')
  })
})

describe('tokens', () => {
  it('never appear in the state the renderer gets', async () => {
    await signIn(null)
    const text = JSON.stringify(published)
    expect(text).not.toContain('access-secret')
    expect(text).not.toContain('refresh-secret')
  })
})

describe.skipIf(process.platform === 'darwin')('with the real credential store', () => {
  it('leaves a signed-in profile that the login check and the email check both see', async () => {
    accounts = new ClaudeAccounts(deps({ writeLogin, loginState: (dir) => loginState(dir, 1) }))
    await signIn(null)
    const [added] = store.accounts()
    const file = join(root, added.id, '.credentials.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth.refreshToken).toBe('refresh-secret')
    expect((await accounts.state()).accounts.at(-1)?.signedOut).toBe(false)
  })
})

describe('through the real loopback listener', () => {
  const pages = { done: 'done page', failed: 'failed page' }

  it('lists the account when the browser comes back with the state', async () => {
    const urls: string[] = []
    accounts = new ClaudeAccounts(
      deps({
        signIn: {
          ...signInDeps(),
          listen: ({ state, timeoutMs }) =>
            openCallbackListener({ state, timeoutMs, pages, redirectName: 'localhost' }),
          openExternal: (url) => urls.push(url) > 0,
        },
      }),
    )
    expect(await accounts.beginSignIn(null)).toBe('started')
    expect(accounts.openSignIn()).toBe(true)
    const authorize = new URL(urls[0])
    const redirect = new URL(authorize.searchParams.get('redirect_uri') as string)
    expect(redirect.hostname).toBe('localhost')
    const back = new URL(`http://127.0.0.1:${redirect.port}${redirect.pathname}`)
    back.searchParams.set('code', CODE)
    back.searchParams.set('state', 'wrong')
    expect((await fetch(back)).status).toBe(400)
    expect((await accounts.state()).signIn).toBe('waiting')
    back.searchParams.set('state', 's')
    expect((await fetch(back)).status).toBe(200)
    await vi.waitFor(() =>
      expect(store.accounts().map((a) => a.email)).toEqual(['work@example.com']),
    )
    await vi.waitFor(async () => expect((await accounts.state()).signIn).toBe('idle'))
    await expect(fetch(back)).rejects.toThrow()
  })

  it('closes the port when the browser reports an error', async () => {
    const urls: string[] = []
    accounts = new ClaudeAccounts(
      deps({
        signIn: {
          ...signInDeps(),
          openExternal: (url) => urls.push(url) > 0,
          listen: ({ state, timeoutMs }) =>
            openCallbackListener({ state, timeoutMs, pages, redirectName: 'localhost' }),
        },
      }),
    )
    await accounts.beginSignIn(null)
    accounts.openSignIn()
    const redirect = new URL(new URL(urls[0]).searchParams.get('redirect_uri') as string)
    const back = new URL(`http://127.0.0.1:${redirect.port}/callback?error=access_denied&state=s`)
    expect((await fetch(back)).status).toBe(400)
    await vi.waitFor(async () => expect((await accounts.state()).signIn).toBe('failed'))
    await expect(fetch(back)).rejects.toThrow()
    expect(store.accounts()).toEqual([])
  })
})
