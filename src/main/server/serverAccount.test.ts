import { afterEach, describe, expect, it } from 'vitest'
import { type AccountHarness, accountHarness } from '../../../test/fixtures/server/accountHarness'
import { cleanDeviceName } from './serverAccount'

let harness: AccountHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe('signing in with an invite code', () => {
  it('SVA-C26 registers this device, keeps the identity and the encrypted keys, and reports it', async () => {
    harness = await accountHarness()
    harness.server.invites.add('code-1')
    expect(await harness.account.signInWithInvite(' code-1 ')).toEqual({ ok: true })
    const status = harness.account.status()
    expect(status).toMatchObject({
      signedIn: true,
      provider: 'invite',
      deviceName: 'Test desktop',
      host: new URL(harness.server.url).host,
    })
    expect(harness.keysSaved()).toBe(true)
    expect(JSON.stringify(status)).not.toMatch(/device1|account1/)
    expect(harness.server.devices.get('device1')?.name).toBe('Test desktop')
  })

  it('SVA-C27 maps an unknown or used code to invalid-invite and stores nothing', async () => {
    harness = await accountHarness()
    expect(await harness.account.signInWithInvite('nope')).toEqual({
      ok: false,
      error: 'invalid-invite',
    })
    expect(harness.account.status().signedIn).toBe(false)
    expect(harness.keysSaved()).toBe(false)
  })

  it('SVA-C28 refuses a second sign-in and a missing server address', async () => {
    harness = await accountHarness()
    harness.server.invites.add('a')
    harness.server.invites.add('b')
    await harness.account.signInWithInvite('a')
    expect(await harness.account.signInWithInvite('b')).toEqual({
      ok: false,
      error: 'already-signed-in',
    })
  })

  it('SVA-C43 has nobody to sign in to until an address is set', async () => {
    harness = await accountHarness({ url: '' })
    expect(await harness.account.signInWithInvite('a')).toEqual({ ok: false, error: 'no-server' })
    expect(await harness.account.githubStart()).toEqual({ ok: false, error: 'no-server' })
  })

  it('SVA-C29 signs in nowhere when the keys cannot be encrypted', async () => {
    harness = await accountHarness({ canEncrypt: false })
    harness.server.invites.add('a')
    expect(await harness.account.signInWithInvite('a')).toEqual({ ok: false, error: 'unavailable' })
    expect(harness.server.devices.size).toBe(0)
  })

  it('SVA-C30 reports an unreachable server', async () => {
    harness = await accountHarness()
    await harness.server.close()
    expect(await harness.account.signInWithInvite('a')).toEqual({ ok: false, error: 'unreachable' })
    expect((await harness.account.info()).ok).toBe(false)
  })

  it('SVA-C31 maps the server limits and rate limit', async () => {
    harness = await accountHarness()
    harness.server.intercept(
      'POST /v1/auth/invite',
      { status: 409, body: { error: 'device-limit' } },
      { status: 429, body: { error: 'rate-limited' }, headers: { 'Retry-After': '120' } },
      { status: 503, body: { error: 'busy' } },
    )
    expect(await harness.account.signInWithInvite('a')).toEqual({
      ok: false,
      error: 'device-limit',
    })
    expect(await harness.account.signInWithInvite('a')).toEqual({
      ok: false,
      error: 'rate-limited',
    })
    expect(await harness.account.signInWithInvite('a')).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('signing in with GitHub', () => {
  it('SVA-C32 shows the user code and link, polls pending then done, and signs in', async () => {
    harness = await accountHarness({ github: true })
    const account = harness.account
    const started = await account.githubStart()
    expect(started).toEqual({
      ok: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.test/login/device',
    })
    expect(account.verificationUri()).toBe('https://github.test/login/device')
    expect(await account.githubPoll()).toEqual({ state: 'pending' })
    expect(await account.githubPoll()).toEqual({ state: 'done' })
    expect(account.status()).toMatchObject({ signedIn: true, provider: 'github' })
    expect(account.verificationUri()).toBeNull()
  })

  it('SVA-C33 does not poll the server again before the interval has passed', async () => {
    const now = 1_000_000
    harness = await accountHarness({ github: true, now: () => now })
    harness.server.intercept('POST /v1/auth/github/device', {
      status: 200,
      body: {
        flowId: 'f',
        userCode: 'WXYZ-0000',
        verificationUri: 'https://github.test/login/device',
        interval: 5,
        expiresIn: 900,
      },
    })
    await harness.account.githubStart()
    expect(await harness.account.githubPoll()).toEqual({ state: 'pending' })
    expect(harness.server.githubPolls).toBe(0)
  })

  it('SVA-C34 reports a refused sign-in and ends the flow', async () => {
    harness = await accountHarness({ github: true })
    harness.server.githubDenied = true
    await harness.account.githubStart()
    expect(await harness.account.githubPoll()).toEqual({ state: 'error', error: 'denied' })
    expect(await harness.account.githubPoll()).toMatchObject({ state: 'error' })
    expect(harness.account.status().signedIn).toBe(false)
  })

  it('SVA-C35 reports an expired flow', async () => {
    harness = await accountHarness({ github: true })
    await harness.account.githubStart()
    harness.server.intercept('POST /v1/auth/github/poll', {
      status: 410,
      body: { error: 'expired' },
    })
    expect(await harness.account.githubPoll()).toEqual({ state: 'error', error: 'expired' })
  })

  it('SVA-C36 forgets the flow when the human cancels', async () => {
    harness = await accountHarness({ github: true })
    await harness.account.githubStart()
    harness.account.githubCancel()
    expect(harness.account.verificationUri()).toBeNull()
    expect(await harness.account.githubPoll()).toMatchObject({ state: 'error' })
  })

  it('SVA-C37 never offers a verification link that is not https', async () => {
    harness = await accountHarness({ github: true })
    harness.server.intercept('POST /v1/auth/github/device', {
      status: 200,
      body: {
        flowId: 'f',
        userCode: 'A',
        verificationUri: 'file:///etc/passwd',
        interval: 0,
        expiresIn: 1,
      },
    })
    await harness.account.githubStart()
    expect(harness.account.verificationUri()).toBeNull()
  })
})

describe('the signed-in account', () => {
  async function signedInAccount(): Promise<AccountHarness> {
    const made = await accountHarness()
    made.server.invites.add('c')
    await made.account.signInWithInvite('c')
    return made
  }

  it('SVA-C38 lists the account devices and marks this one', async () => {
    harness = await signedInAccount()
    const result = await harness.account.devices()
    expect(result).toEqual({
      ok: true,
      devices: [{ id: 'device1', name: 'Test desktop', current: true, lastSeen: 0 }],
    })
  })

  it('SVA-C39 signs out: ends the session, forgets identity and keys, and tells listeners', async () => {
    harness = await signedInAccount()
    const { token } = await harness.session.ensure()
    let changes = 0
    harness.account.onChange(() => {
      changes += 1
    })
    expect(await harness.account.signOut()).toEqual({ ok: true })
    expect(harness.server.sessions.has(token)).toBe(false)
    expect(harness.account.status().signedIn).toBe(false)
    expect(harness.saved().identity).toBeNull()
    expect(changes).toBe(1)
    expect(await harness.account.devices()).toEqual({ ok: false, error: 'not-signed-in' })
  })

  it('SVA-C40 keeps the address fixed while signed in', async () => {
    harness = await signedInAccount()
    expect(harness.account.setUrl('https://other.example')).toEqual({
      ok: false,
      error: 'already-signed-in',
    })
  })

  it('SVA-C41 reads what the server offers from /v1/info', async () => {
    harness = await accountHarness({ github: true })
    expect(await harness.account.info()).toEqual({
      ok: true,
      offer: {
        relay: true,
        publish: true,
        sync: true,
        push: false,
        invite: true,
        github: true,
      },
    })
  })
})

describe('the device name', () => {
  it('SVA-C42 keeps printable characters, at most 64, and never an empty name', () => {
    expect(cleanDeviceName('  my\u0007box\n ')).toBe('mybox')
    expect(cleanDeviceName('x'.repeat(100))).toHaveLength(64)
    expect(cleanDeviceName('\u0007')).toBe('Ostia')
  })
})
