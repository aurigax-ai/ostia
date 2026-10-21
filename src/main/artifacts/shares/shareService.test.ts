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
}

function options(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    mode: 'link',
    password: '',
    withLinkKey: false,
    expiresInSeconds: 30 * DAY,
    acceptFindings: false,
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
    writeClipboard: (text) => clipboard.push(text),
  })
  return { service, harness, clipboard, sealed: () => JSON.stringify(saved), store, spans }
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
    expect(first).toEqual({
      ok: false,
      reason: 'findings',
      findings: [{ kind: 'stripe', line: 2, masked: 'sk_…' }],
    })
    expect(JSON.stringify(first)).not.toContain(secret)
    expect(r.harness.server.shares.size).toBe(0)
    const second = await r.service.publish(
      { file, source: SOURCE, name: 'plan.html' },
      options({ acceptFindings: true }),
    )
    expect(second.ok).toBe(true)
    expect(r.harness.server.shares.size).toBe(1)
  })

  it('SHR-C21 uploads nothing when the scan fails', async () => {
    const r = await rig()
    r.spans.value = new Error('worker died')
    expect(await publish(r)).toEqual({ ok: false, reason: 'scan-failed' })
    expect(await publish(r, { acceptFindings: true })).toEqual({
      ok: false,
      reason: 'scan-failed',
    })
    expect(r.harness.server.shares.size).toBe(0)
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
