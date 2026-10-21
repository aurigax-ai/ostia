import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionConnectionKind } from '@aurigax-ai/ostia-extension-sdk/contract/extensionConnections'
import { describe, expect, it } from 'vitest'
import { connectionSecretKey, ExtensionConnections } from './extensionConnections'
import { createSecretStore, type SecretStoreDeps } from './extensionSecrets'

const HTTP: ExtensionConnectionKind = {
  kind: 'http',
  title: 'HTTP API',
  fields: [
    { key: 'baseUrl', title: 'Base URL', type: 'string', required: true },
    {
      key: 'auth',
      title: 'Auth',
      type: 'enum',
      enum: ['none', 'bearer', 'header', 'basic'],
      default: 'bearer',
    },
    { key: 'header', title: 'Header', type: 'string' },
  ],
  secrets: [{ key: 'secret', title: 'Token' }],
}
const KINDS = [HTTP]
const TOKEN = ['tok', 'x'.repeat(20)].join('-')

function setup() {
  let data: unknown = {}
  const deps: SecretStoreDeps = {
    load: () => data,
    save: (next) => {
      data = JSON.parse(JSON.stringify(next))
    },
    canEncrypt: () => true,
    encrypt: (plain) => Buffer.from(`x${plain}`).toString('base64'),
    decrypt: (secret) => Buffer.from(secret, 'base64').toString().slice(1),
  }
  const secrets = createSecretStore(deps)
  const path = join(mkdtempSync(join(tmpdir(), 'ostia-connections-')), 'extension-connections.json')
  const store = new ExtensionConnections(path, () => secrets)
  return { store, secrets, path, raw: () => data }
}

const save = (store: ExtensionConnections, req: unknown, extId = 'graphs') =>
  store.save(extId, KINDS, req)

describe('extension connections', () => {
  it('saves fields to its file and the secret encrypted, and gives both only to its extension by name', () => {
    const { store, path, raw } = setup()
    expect(
      save(store, {
        name: 'api',
        kind: 'http',
        fields: { baseUrl: 'https://api.example.test' },
        secrets: { secret: TOKEN },
      }),
    ).toEqual({ ok: true })
    expect(readFileSync(path, 'utf8')).not.toContain(TOKEN)
    expect(JSON.stringify(raw())).not.toContain(TOKEN)
    expect(store.list('graphs', KINDS)).toEqual([
      {
        name: 'api',
        kind: 'http',
        fields: { baseUrl: 'https://api.example.test', auth: 'bearer' },
        secretsSet: ['secret'],
      },
    ])
    expect(JSON.stringify(store.list('graphs', KINDS))).not.toContain(TOKEN)
    expect(store.names('graphs', KINDS)).toEqual([{ name: 'api', kind: 'http' }])
    expect(store.value('graphs', KINDS, 'api')).toEqual({
      name: 'api',
      kind: 'http',
      fields: { baseUrl: 'https://api.example.test', auth: 'bearer' },
      secrets: { secret: TOKEN },
    })
    expect(store.value('other', KINDS, 'api')).toBeNull()
    expect(store.names('other', KINDS)).toEqual([])
    expect(store.value('graphs', KINDS, 'nope')).toBeNull()
  })

  it('refuses a bad name, an unknown kind, field or secret, a bad enum value, a missing required field and a long value', () => {
    const { store } = setup()
    const base = { name: 'api', kind: 'http', fields: { baseUrl: 'https://a.test' } }
    const refusals = [
      { ...base, name: 'Bad Name' },
      { ...base, name: '__proto__' },
      { ...base, kind: 'ftp' },
      { ...base, fields: { baseUrl: 'https://a.test', extra: 'x' } },
      { ...base, fields: { baseUrl: 'https://a.test', auth: 'oauth' } },
      { ...base, fields: {} },
      { ...base, fields: { baseUrl: 'x'.repeat(2049) } },
      { ...base, secrets: { other: 'x' } },
      { ...base, secrets: { secret: 'x'.repeat(4097) } },
      { ...base, secrets: { secret: '' } },
    ]
    expect(refusals.map((r) => save(store, r))).toEqual(
      refusals.map(() => expect.objectContaining({ ok: false })),
    )
    expect(save(store, { ...base, name: 'ok' }).ok).toBe(true)
    expect(save(store, null)).toMatchObject({ ok: false })
  })

  it('refuses a secret or field value with a control character, and says so without the value', () => {
    const { store } = setup()
    const base = { name: 'api', kind: 'http', fields: { baseUrl: 'https://a.test' } }
    for (const bad of [`${TOKEN}\r\nX-Evil: 1`, `${TOKEN}\n`, 'a\u0000b', 'a\u007fb', 'a\tb']) {
      const res = save(store, { ...base, secrets: { secret: bad } })
      expect(res).toMatchObject({ ok: false })
      expect(JSON.stringify(res)).not.toContain(TOKEN)
      expect(save(store, { ...base, fields: { baseUrl: `https://a.test/${bad}` } })).toMatchObject({
        ok: false,
      })
    }
    expect(store.list('graphs', KINDS)).toEqual([])
  })

  it('keeps an omitted secret, clears a null one, and removing a connection drops its secrets', () => {
    const { store, secrets } = setup()
    const base = { name: 'api', kind: 'http', fields: { baseUrl: 'https://a.test' } }
    save(store, { ...base, secrets: { secret: TOKEN } })
    save(store, {
      name: 'apiary',
      kind: 'http',
      fields: { baseUrl: 'https://b.test' },
      secrets: { secret: 'keep' },
    })
    save(store, { ...base, fields: { baseUrl: 'https://c.test' } })
    expect(store.value('graphs', KINDS, 'api')?.secrets).toEqual({ secret: TOKEN })
    save(store, { ...base, secrets: { secret: null } })
    expect(store.value('graphs', KINDS, 'api')?.secrets).toEqual({})
    save(store, { ...base, secrets: { secret: TOKEN } })
    expect(store.remove('graphs', 'api')).toEqual({ ok: true })
    expect(secrets.keys('graphs')).toEqual([connectionSecretKey('apiary', 'secret')])
    expect(store.remove('graphs', 'api')).toMatchObject({ ok: false, error: 'unknown-connection' })
    expect(store.value('graphs', KINDS, 'apiary')?.secrets).toEqual({ secret: 'keep' })
  })

  it('holds at most 32 connections per extension and forgets an extension whole', () => {
    const { store } = setup()
    for (let i = 0; i < 32; i++) {
      expect(
        save(store, { name: `c${i}`, kind: 'http', fields: { baseUrl: 'https://a.test' } }).ok,
      ).toBe(true)
    }
    expect(
      save(store, { name: 'c32', kind: 'http', fields: { baseUrl: 'https://a.test' } }),
    ).toMatchObject({
      ok: false,
      error: 'too-many-connections',
    })
    expect(
      save(store, { name: 'c0', kind: 'http', fields: { baseUrl: 'https://z.test' } }).ok,
    ).toBe(true)
    store.forget('graphs')
    expect(store.names('graphs', KINDS)).toEqual([])
  })

  it('hides a connection whose kind the extension no longer declares', () => {
    const { store } = setup()
    save(store, { name: 'api', kind: 'http', fields: { baseUrl: 'https://a.test' } })
    expect(store.names('graphs', [])).toEqual([])
    expect(store.value('graphs', [], 'api')).toBeNull()
  })
})
