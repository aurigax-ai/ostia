import { afterEach, describe, expect, it } from 'vitest'
import {
  type AccountHarness,
  accountHarness,
  signedIn,
} from '../../../../test/fixtures/server/accountHarness'
import type { PortableResult } from '../../../shared/artifacts/portable'
import type { PublishOptions } from '../../../shared/artifacts/shares'
import type { SecretSpan } from '../../../shared/privacy/redaction'
import { decryptShare, deriveShareKey } from './shareCrypto'
import { ShareService } from './shareService'
import { ShareStore } from './shareStore'

const FILE = '<!doctype html><title>héllo ✓</title><p>portable artifact</p>'
const SOURCE = '/work/artifacts/plan.html'
const DAY = 86_400

let harness: AccountHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

interface Rig {
  service: ShareService
  harness: AccountHarness
  clipboard: string[]
  sealed: () => string
  store: ShareStore
  spans: { value: SecretSpan[] | Error }
  probe: { status: number | null; urls: string[] }
}

function options(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    mode: 'link',
    password: '',
    withLinkKey: false,
    expiresInSeconds: 30 * DAY,
    acceptedDigest: '',
    ...over,
  }
}

async function rig(
  serverOptions: Parameters<typeof accountHarness>[0] = {},
  signed = true,
): Promise<Rig> {
  harness = signed ? await signedIn(serverOptions) : await accountHarness(serverOptions)
  let saved: unknown = {}
  const clipboard: string[] = []
  const spans: Rig['spans'] = { value: [] }
  const probe: Rig['probe'] = { status: 404, urls: [] }
  const store = new ShareStore({
    load: () => saved,
    save: (data) => {
      saved = data
    },
    canEncrypt: () => true,
    encrypt: (plain) => `enc:${Buffer.from(plain).reverse().toString('base64')}`,
    decrypt: (secret) => Buffer.from(secret.slice(4), 'base64').reverse().toString(),
  })
  const service = new ShareService({
    account: harness.account,
    store,
    scan: async () => {
      if (spans.value instanceof Error) throw spans.value
      return spans.value
    },
    probe: async (url) => {
      probe.urls.push(url)
      return probe.status
    },
    writeClipboard: (text) => clipboard.push(text),
  })
  return { service, harness, clipboard, sealed: () => JSON.stringify(saved), store, spans, probe }
}

function publish(r: Rig, over: Partial<PublishOptions> = {}): Promise<PortableResult> {
  return r.service.publish({ file: FILE, source: SOURCE, name: 'plan.html' }, options(over))
}

function linkKey(link: string): Buffer {
  return Buffer.from(new URL(link).hash.slice('#k='.length), 'base64url')
}

function uploadedBlob(r: Rig, id: string): Buffer {
  const blob = r.harness.server.shares.get(id)?.blob
  if (!blob) throw new Error('nothing was uploaded')
  return blob
}

describe('publishing a share', () => {
  it('SHR-C10 encrypts a link share, declares len+29 and opens with the key of the copied link', async () => {
    const r = await rig()
    const result = await publish(r)
    expect(result.ok).toBe(true)
    if (!result.ok || !result.share) throw new Error('published')
    const { share } = result
    const stored = r.harness.server.shares.get(share.id)
    expect(stored?.size).toBe(Buffer.byteLength(FILE) + 29)
    expect(share.size).toBe(Buffer.byteLength(FILE) + 29)
    expect(uploadedBlob(r, share.id).toString('utf8')).not.toContain('portable artifact')
    expect(r.service.copyLink(share.id)).toEqual({ ok: true })
    const link = r.clipboard[0] ?? ''
    expect(link.startsWith(share.url)).toBe(true)
    const plain = decryptShare(share.id, linkKey(link), uploadedBlob(r, share.id))
    expect(plain.toString('utf8')).toBe(FILE)
  })

  it('SHR-C11 derives a password share key from the password and the salt the server holds', async () => {
    const r = await rig()
    const result = await publish(r, { mode: 'password', password: 'correct horse ü' })
    if (!result.ok || !result.share) throw new Error('published')
    const stored = r.harness.server.shares.get(result.share.id)
    const salt = Buffer.from(stored?.salt ?? '', 'base64url')
    expect(salt.length).toBe(16)
    const key = await deriveShareKey({ mode: 'password', password: 'correct horse ü', salt })
    expect(decryptShare(result.share.id, key, uploadedBlob(r, result.share.id)).toString()).toBe(
      FILE,
    )
    r.service.copyLink(result.share.id)
    expect(r.clipboard[0]).toBe(result.share.url)
  })

  it('SHR-C12 combines the password with a link key when asked', async () => {
    const r = await rig()
    const result = await publish(r, {
      mode: 'password',
      password: 'long enough',
      withLinkKey: true,
    })
    if (!result.ok || !result.share) throw new Error('published')
    r.service.copyLink(result.share.id)
    const salt = Buffer.from(r.harness.server.shares.get(result.share.id)?.salt ?? '', 'base64url')
    const key = await deriveShareKey({
      mode: 'password',
      password: 'long enough',
      salt,
      fragment: linkKey(r.clipboard[0] ?? ''),
    })
    expect(decryptShare(result.share.id, key, uploadedBlob(r, result.share.id)).toString()).toBe(
      FILE,
    )
  })

  it('SHR-C13 uploads a public share as the file itself only when the server allows it', async () => {
    const closed = await rig()
    expect(await publish(closed, { mode: 'public' })).toEqual({ ok: false, reason: 'public-off' })
    expect(closed.harness.server.shares.size).toBe(0)
    await harness?.close()
    const open = await rig({ allowPublic: true })
    const result = await publish(open, { mode: 'public' })
    if (!result.ok || !result.share) throw new Error('published')
    expect(open.harness.server.shares.get(result.share.id)?.size).toBe(Buffer.byteLength(FILE))
    expect(uploadedBlob(open, result.share.id).toString('utf8')).toBe(FILE)
  })

  it('SHR-C14 offers never only when the server allows it and refuses unknown expiries', async () => {
    const closed = await rig()
    expect(await publish(closed, { expiresInSeconds: 0 })).toEqual({
      ok: false,
      reason: 'never-off',
    })
    expect(await publish(closed, { expiresInSeconds: 5 })).toEqual({
      ok: false,
      reason: 'bad-options',
    })
    await harness?.close()
    const open = await rig({ allowNever: true })
    const result = await publish(open, { expiresInSeconds: 0 })
    if (!result.ok || !result.share) throw new Error('published')
    expect(result.share.expiresAt).toBe(0)
  })

  it('SHR-C15 refuses a weak password and a file over the server limit before any request', async () => {
    const r = await rig({ shareMaxBytes: 50 })
    expect(await publish(r, { mode: 'password', password: 'short' })).toEqual({
      ok: false,
      reason: 'bad-options',
    })
    expect(await publish(r)).toEqual({ ok: false, reason: 'too-large' })
    expect(r.harness.server.requests.filter((q) => q.startsWith('POST /v1/shares'))).toEqual([])
  })

  it('SHR-C16 uploads nothing when the human is signed out', async () => {
    const r = await rig({}, false)
    expect(await publish(r)).toEqual({ ok: false, reason: 'signed-out' })
    expect(r.harness.server.requests.filter((q) => q.includes('/v1/shares'))).toEqual([])
  })

  it('SHR-C17 reports a server with publishing off and an unreachable server', async () => {
    const off = await rig({ publish: false })
    expect(await publish(off)).toEqual({ ok: false, reason: 'publish-off' })
    expect(await off.service.availability()).toEqual({ state: 'off' })
    await harness?.close()
    const gone = await rig()
    await gone.harness.server.close()
    expect(await publish(gone)).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('SHR-C18 reports the quota and removes nothing it did not create', async () => {
    const r = await rig({ maxShares: 1 })
    expect((await publish(r)).ok).toBe(true)
    expect(await publish(r)).toEqual({ ok: false, reason: 'quota' })
    expect(r.harness.server.shares.size).toBe(1)
  })

  it('SHR-C19 never sends the session token to an upload address of another origin', async () => {
    const r = await rig()
    r.harness.server.intercept('POST /v1/shares', {
      status: 201,
      body: {
        id: 'abcdefghijklmnopqrstuvwxyz',
        url: 'http://x.shares.test/',
        uploadUrl: 'http://evil.test/v1/shares/abc/blob',
        deleteToken: 'tok',
        expiresAt: 0,
      },
    })
    expect(await publish(r)).toEqual({ ok: false, reason: 'failed' })
    expect(r.store.list()).toEqual([])
  })
})

describe('the secret scan before publishing', () => {
  it('SHR-C20 shows masked findings with their lines and uploads nothing until the second click', async () => {
    const r = await rig()
    const secret = 'sk_live_abcdefghijklmnop'
    const file = `line one\nkey = ${secret}\n`
    const start = file.indexOf(secret)
    r.spans.value = [{ start, end: start + secret.length, kind: 'stripe' }]
    const first = await r.service.publish({ file, source: SOURCE, name: 'plan.html' }, options())
    expect(first).toMatchObject({
      ok: false,
      reason: 'findings',
      findings: [{ kind: 'stripe', line: 2, masked: 'sk_…' }],
    })
    expect(JSON.stringify(first)).not.toContain(secret)
    expect(r.harness.server.shares.size).toBe(0)
    const digest = first.ok ? '' : (first.findingsDigest ?? '')
    expect(digest).not.toBe('')
    const second = await r.service.publish(
      { file, source: SOURCE, name: 'plan.html' },
      options({ acceptedDigest: digest }),
    )
    expect(second.ok).toBe(true)
    expect(r.harness.server.shares.size).toBe(1)
  })

  it('SHR-C21 uploads nothing when the scan fails', async () => {
    const r = await rig()
    r.spans.value = new Error('worker died')
    expect(await publish(r)).toEqual({ ok: false, reason: 'scan-failed' })
    expect(await publish(r, { acceptedDigest: 'anything' })).toEqual({
      ok: false,
      reason: 'scan-failed',
    })
    expect(r.harness.server.shares.size).toBe(0)
  })
})

describe('accepting findings', () => {
  const secretOf = (value: string) => `key = ${value}\n`

  async function shown(r: Rig, file: string, kind: string): Promise<PortableResult> {
    const start = file.indexOf('sk_')
    r.spans.value = [{ start, end: file.length - 1, kind }]
    return r.service.publish({ file, source: SOURCE, name: 'plan.html' }, options())
  }

  it('SHR-C22 refuses the second click when the file changed to other findings and shows them again', async () => {
    const r = await rig()
    const seen = secretOf('sk_live_first_secret')
    const first = await shown(r, seen, 'stripe')
    const digest = first.ok ? '' : (first.findingsDigest ?? '')
    const changed = secretOf('sk_live_other_secret')
    const start = changed.indexOf('sk_')
    r.spans.value = [{ start, end: changed.length - 1, kind: 'stripe' }]
    const second = await r.service.publish(
      { file: changed, source: SOURCE, name: 'plan.html' },
      options({ acceptedDigest: digest }),
    )
    expect(second).toMatchObject({ ok: false, reason: 'findings' })
    expect(second.ok ? '' : second.findingsDigest).not.toBe(digest)
    expect(r.harness.server.shares.size).toBe(0)
  })

  it('SHR-C23 refuses a digest taken for a file whose findings vanished and then returned elsewhere', async () => {
    const r = await rig()
    const seen = secretOf('sk_live_first_secret')
    const first = await shown(r, seen, 'stripe')
    const digest = first.ok ? '' : (first.findingsDigest ?? '')
    const moved = `# new\n${seen}`
    const start = moved.indexOf('sk_')
    r.spans.value = [{ start, end: moved.length - 1, kind: 'stripe' }]
    const second = await r.service.publish(
      { file: moved, source: SOURCE, name: 'plan.html' },
      options({ acceptedDigest: digest }),
    )
    expect(second).toMatchObject({ ok: false, reason: 'findings' })
    expect(r.harness.server.shares.size).toBe(0)
  })

  it('SHR-C24 uploads when the same findings are accepted', async () => {
    const r = await rig()
    const file = secretOf('sk_live_first_secret')
    const first = await shown(r, file, 'stripe')
    const digest = first.ok ? '' : (first.findingsDigest ?? '')
    const second = await r.service.publish(
      { file, source: SOURCE, name: 'plan.html' },
      options({ acceptedDigest: digest }),
    )
    expect(second.ok).toBe(true)
  })
})

describe('the record store', () => {
  it('SHR-C30 keeps the delete token and link key encrypted and out of every renderer answer', async () => {
    const r = await rig()
    const result = await publish(r)
    if (!result.ok || !result.share) throw new Error('published')
    const record = r.store.get(result.share.id)
    expect(record?.deleteToken).toBe(r.harness.server.shares.get(result.share.id)?.deleteToken)
    expect(record?.linkKey).not.toBeNull()
    expect(r.sealed()).not.toContain(record?.deleteToken ?? 'x')
    expect(r.sealed()).not.toContain(record?.linkKey ?? 'x')
    const listed = await r.service.list()
    for (const answer of [result, listed]) {
      const text = JSON.stringify(answer)
      expect(text).not.toContain(record?.deleteToken ?? 'x')
      expect(text).not.toContain(record?.linkKey ?? 'x')
    }
  })

  it('SHR-C31 refuses to publish where nothing can encrypt the record', async () => {
    const r = await rig()
    const blocked = new ShareService({
      account: r.harness.account,
      store: new ShareStore({
        load: () => ({}),
        save: () => {},
        canEncrypt: () => false,
        encrypt: (p) => p,
        decrypt: (p) => p,
      }),
      scan: async () => [],
      probe: async () => null,
      writeClipboard: () => {},
    })
    expect(
      await blocked.publish({ file: FILE, source: SOURCE, name: 'plan.html' }, options()),
    ).toEqual({ ok: false, reason: 'unavailable' })
    expect(r.harness.server.shares.size).toBe(0)
  })

  it('SHR-C32 merges the server list with local records and forgets records the server no longer has', async () => {
    const r = await rig()
    const mine = await publish(r)
    if (!mine.ok || !mine.share) throw new Error('published')
    const gone = await publish(r)
    if (!gone.ok || !gone.share) throw new Error('published')
    r.harness.server.shares.delete(gone.share.id)
    const other = r.harness.server.shares
    other.set('zzzz', {
      ...(other.get(mine.share.id) as NonNullable<ReturnType<typeof other.get>>),
      id: 'zzzz',
      createdAt: 1,
    })
    const listed = await r.service.list()
    if (!listed.ok) throw new Error('listed')
    expect(listed.shares.map((s) => [s.id, s.name, s.source, s.linkable])).toEqual([
      [mine.share.id, 'plan.html', SOURCE, true],
      ['zzzz', null, null, false],
    ])
    expect(r.store.get(gone.share.id)).toBeNull()
  })

  it('SHR-C33 reports views and expired shares from the server', async () => {
    const r = await rig()
    const result = await publish(r)
    if (!result.ok || !result.share) throw new Error('published')
    const stored = r.harness.server.shares.get(result.share.id)
    if (stored) {
      stored.views = 3
      stored.expiresAt = r.harness.server.now() - 1
    }
    const listed = await r.service.list()
    if (!listed.ok) throw new Error('listed')
    expect(listed.shares[0]).toMatchObject({ views: 3, expired: true, uploaded: true })
  })
})

describe('deleting a share', () => {
  it('SHR-C40 deletes with the delete token, even without a session', async () => {
    const r = await rig()
    const result = await publish(r)
    if (!result.ok || !result.share) throw new Error('published')
    await r.harness.account.signOut()
    expect(await r.service.remove(result.share.id)).toEqual({ ok: true })
    expect(r.harness.server.shares.size).toBe(0)
    expect(r.store.get(result.share.id)).toBeNull()
  })

  it('SHR-C41 falls back to the session when the token is refused', async () => {
    const r = await rig()
    const result = await publish(r)
    if (!result.ok || !result.share) throw new Error('published')
    const record = r.store.get(result.share.id)
    if (!record) throw new Error('record')
    r.store.add({ ...record, deleteToken: 'wrong' })
    expect(await r.service.remove(result.share.id)).toEqual({ ok: true })
    expect(r.harness.server.shares.size).toBe(0)
  })

  it('SHR-C42 deletes a share only the server knows by the session, and treats a missing one as gone', async () => {
    const r = await rig()
    const result = await publish(r)
    if (!result.ok || !result.share) throw new Error('published')
    r.store.remove(result.share.id)
    expect(await r.service.remove(result.share.id)).toEqual({ ok: true })
    expect(r.harness.server.shares.size).toBe(0)
    expect(await r.service.remove(result.share.id)).toEqual({ ok: true })
  })

  it('SHR-C43 keeps the record and says so when the server cannot be reached', async () => {
    const r = await rig()
    const result = await publish(r)
    if (!result.ok || !result.share) throw new Error('published')
    await r.harness.server.close()
    expect(await r.service.remove(result.share.id)).toEqual({ ok: false, error: 'unreachable' })
    expect(r.store.get(result.share.id)).not.toBeNull()
  })

  it('SHR-C44 answers unknown for a link nobody published', async () => {
    const r = await rig()
    expect(r.service.copyLink('nothing')).toEqual({ ok: false, error: 'unknown' })
    expect(r.clipboard).toEqual([])
  })
})

describe('records of other servers and accounts', () => {
  async function twoServers() {
    const first = await rig()
    const second = await signedIn()
    const current = { account: first.harness.account }
    const service = new ShareService({
      account: {
        signedIn: () => current.account.signedIn(),
        authed: (use) => current.account.authed(use),
        unauthed: (use) => current.account.unauthed(use),
        fetchInfo: () => current.account.fetchInfo(),
        baseUrl: () => current.account.baseUrl(),
        identity: () => current.account.identity(),
      },
      store: first.store,
      scan: async () => [],
      probe: async () => first.probe.status,
      writeClipboard: (text) => first.clipboard.push(text),
    })
    return { first, second, current, service }
  }

  it('SHR-C80 keeps the records of a server after signing out and in to another one, and never sends its token there', async () => {
    const { first, second, current, service } = await twoServers()
    const made = await service.publish({ file: FILE, source: SOURCE, name: 'plan.html' }, options())
    if (!made.ok || !made.share) throw new Error('published')
    const id = made.share.id
    const token = first.harness.server.shares.get(id)?.deleteToken ?? ''
    await first.harness.account.signOut()
    current.account = second.account
    const listed = await service.list()
    expect(listed).toEqual({ ok: true, shares: [] })
    expect(first.store.get(id)).not.toBeNull()
    expect(service.copyLink(id)).toEqual({ ok: false, error: 'unknown' })
    expect(await service.remove(id)).toEqual({ ok: false, error: 'failed' })
    expect(second.server.requests.filter((q) => q.startsWith('DELETE'))).toEqual([])
    expect(JSON.stringify(second.server.requests)).not.toContain(token)
    expect(first.store.get(id)).not.toBeNull()
    expect(first.harness.server.shares.has(id)).toBe(true)
    await second.close()
  })

  it('SHR-C81 keeps the records of an account when another account of the same server lists', async () => {
    const first = await rig()
    const made = await publish(first)
    if (!made.ok || !made.share) throw new Error('published')
    first.harness.server.invites.add('invite-2')
    await first.harness.account.signOut()
    expect(await first.harness.account.signInWithInvite('invite-2')).toEqual({ ok: true })
    expect(await first.service.list()).toEqual({ ok: true, shares: [] })
    expect(first.probe.urls).toEqual([])
    expect(first.store.get(made.share.id)).not.toBeNull()
    expect(first.service.copyLink(made.share.id)).toEqual({ ok: false, error: 'unknown' })
  })

  it('SHR-C82 drops records written without an origin or account', async () => {
    const first = await rig()
    const made = await publish(first)
    if (!made.ok || !made.share) throw new Error('published')
    const record = first.store.get(made.share.id)
    const { origin: _o, accountId: _a, ...old } = record as NonNullable<typeof record>
    first.store.add(old as unknown as NonNullable<typeof record>)
    expect(first.store.list()).toEqual([])
  })
})

describe('pruning the records of the current account', () => {
  it('SHR-C83 keeps every record when the list comes back empty but the share host still answers', async () => {
    const r = await rig()
    const made = await publish(r)
    if (!made.ok || !made.share) throw new Error('published')
    r.harness.server.shares.clear()
    r.probe.status = 200
    expect(await r.service.list()).toEqual({ ok: true, shares: [] })
    expect(r.store.get(made.share.id)).not.toBeNull()
    r.probe.status = null
    await r.service.list()
    expect(r.store.get(made.share.id)).not.toBeNull()
    r.probe.status = 500
    await r.service.list()
    expect(r.store.get(made.share.id)).not.toBeNull()
  })

  it('SHR-C84 drops a record only when its share host answers 404 or 410 for that id', async () => {
    const r = await rig()
    const made = await publish(r)
    if (!made.ok || !made.share) throw new Error('published')
    r.harness.server.shares.clear()
    r.probe.status = 410
    await r.service.list()
    expect(r.probe.urls).toEqual([`${made.share.url}meta`])
    expect(r.store.get(made.share.id)).toBeNull()
  })
})
