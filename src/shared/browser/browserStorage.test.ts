import { describe, expect, it } from 'vitest'
import {
  STORAGE_VALUE_MAX,
  cookieUrl,
  entriesOf,
  normalizeStorageEdit,
  normalizeStorageRemoval,
} from './browserStorage'

const cookie = {
  name: 'sid',
  value: 'abc',
  domain: '.x.test',
  path: '/',
  hostOnly: false,
  expires: 2_000_000_000,
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
}

describe('normalizeStorageEdit', () => {
  it('accepts a web storage entry', () => {
    expect(normalizeStorageEdit({ kind: 'local', key: 'k', value: 'v' })).toEqual({
      kind: 'local',
      key: 'k',
      value: 'v',
    })
  })

  it('accepts a cookie and keeps its flags', () => {
    expect(normalizeStorageEdit({ kind: 'cookies', cookie })).toEqual({ kind: 'cookies', cookie })
  })

  it('falls back to an unspecified SameSite value it does not know', () => {
    const edit = normalizeStorageEdit({ kind: 'cookies', cookie: { ...cookie, sameSite: 'weird' } })
    expect(edit?.kind === 'cookies' && edit.cookie.sameSite).toBe('unspecified')
  })

  it('refuses empty keys, oversized values, bad paths and unknown kinds', () => {
    expect(normalizeStorageEdit({ kind: 'local', key: '', value: 'v' })).toBeNull()
    expect(
      normalizeStorageEdit({ kind: 'session', key: 'k', value: 'x'.repeat(STORAGE_VALUE_MAX + 1) }),
    ).toBeNull()
    expect(
      normalizeStorageEdit({ kind: 'cookies', cookie: { ...cookie, path: 'nope' } }),
    ).toBeNull()
    expect(normalizeStorageEdit({ kind: 'cookies', cookie: { ...cookie, domain: '.' } })).toBeNull()
    expect(normalizeStorageEdit({ kind: 'indexeddb', key: 'k', value: 'v' })).toBeNull()
    expect(normalizeStorageEdit(null)).toBeNull()
  })
})

describe('normalizeStorageRemoval', () => {
  it('keeps only what is needed to find the entry', () => {
    expect(normalizeStorageRemoval({ kind: 'cookies', cookie })).toEqual({
      kind: 'cookies',
      cookie: { name: 'sid', domain: '.x.test', path: '/', secure: true },
    })
    expect(normalizeStorageRemoval({ kind: 'session', key: 'k', value: 'ignored' })).toEqual({
      kind: 'session',
      key: 'k',
    })
  })

  it('refuses a removal without a key or name', () => {
    expect(normalizeStorageRemoval({ kind: 'local' })).toBeNull()
    expect(normalizeStorageRemoval({ kind: 'cookies', cookie: { ...cookie, name: '' } })).toBeNull()
  })
})

describe('cookieUrl', () => {
  it('builds the url a cookie belongs to from its domain, path and secure flag', () => {
    expect(cookieUrl({ domain: '.x.test', path: '/app', secure: true })).toBe('https://x.test/app')
    expect(cookieUrl({ domain: 'localhost', path: '/', secure: false })).toBe('http://localhost/')
  })
})

describe('entriesOf', () => {
  it('lists storage entries sorted by key', () => {
    expect(entriesOf({ b: '2', a: '1' })).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ])
  })
})
