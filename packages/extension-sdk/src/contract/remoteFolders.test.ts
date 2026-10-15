import { describe, expect, it } from 'vitest'
import {
  REMOTE_ENTRIES_MAX,
  REMOTE_FILE_MAX_BYTES,
  isInsideRoot,
  isRemotePath,
  normalizeRemoteCwd,
  normalizeRemoteListing,
  normalizeRemotePath,
  normalizeRemoteRead,
  normalizeRemoteStat,
  normalizeRemoteWrite,
  parseRemotePath,
  remoteChild,
  remotePath,
  utf8Length,
} from './remoteFolders'

describe('normalizeRemotePath', () => {
  it('keeps an absolute path, dropping empty and dot segments', () => {
    expect(normalizeRemotePath('/srv/app')).toBe('/srv/app')
    expect(normalizeRemotePath('/srv//app/./x/')).toBe('/srv/app/x')
    expect(normalizeRemotePath('/')).toBe('/')
    expect(normalizeRemotePath('/a b/é')).toBe('/a b/é')
  })

  it('SSH-C62 refuses a relative path, a parent segment, control characters and oversize', () => {
    for (const bad of [
      'srv/app',
      '',
      '/srv/../etc',
      '/..',
      '/a\nb',
      '/a\u0000b',
      '/a\u007fb',
      '/a�b',
      `/${'x'.repeat(5000)}`,
      42,
      null,
    ]) {
      expect(normalizeRemotePath(bad), String(bad)).toBeNull()
    }
  })
})

describe('remote paths', () => {
  it('round-trips a folder id and a path and tells remote paths from local ones', () => {
    const path = remotePath('abcdef012345', '/srv/app/a b.txt')
    expect(path).toBe('remote://abcdef012345/srv/app/a b.txt')
    expect(parseRemotePath(path)).toEqual({ folderId: 'abcdef012345', path: '/srv/app/a b.txt' })
    expect(isRemotePath(path)).toBe(true)
    expect(isRemotePath('/home/me/file')).toBe(false)
    expect(isRemotePath(undefined)).toBe(false)
    expect(remoteChild('remote://abcdef012345/srv', 'x')).toBe('remote://abcdef012345/srv/x')
    expect(remoteChild('remote://abcdef012345/', 'x')).toBe('remote://abcdef012345/x')
  })

  it('SSH-C62 refuses a bad folder id, a missing path and a path that climbs', () => {
    for (const bad of [
      'remote://short/srv',
      'remote://ABCDEF012345/srv',
      'remote://abcdef012345',
      'remote://abcdef012345/srv/../../etc',
      'file:///etc/passwd',
      '/etc/passwd',
      7,
    ]) {
      expect(parseRemotePath(bad), String(bad)).toBeNull()
    }
  })

  it('knows what is inside a root', () => {
    expect(isInsideRoot('/srv/app', '/srv/app')).toBe(true)
    expect(isInsideRoot('/srv/app', '/srv/app/x')).toBe(true)
    expect(isInsideRoot('/srv/app', '/srv/application')).toBe(false)
    expect(isInsideRoot('/srv/app', '/srv')).toBe(false)
    expect(isInsideRoot('/', '/anything')).toBe(true)
  })
})

describe('normalizeRemoteCwd', () => {
  it('SSH-C61 keeps a plain host name and an absolute folder', () => {
    expect(normalizeRemoteCwd({ host: 'db1.internal', cwd: '/srv/app/' })).toEqual({
      host: 'db1.internal',
      cwd: '/srv/app',
    })
  })

  it('refuses a host with odd characters, a relative folder and anything that is not an object', () => {
    expect(normalizeRemoteCwd({ host: 'db 1', cwd: '/srv' })).toBeNull()
    expect(normalizeRemoteCwd({ host: 'db;rm', cwd: '/srv' })).toBeNull()
    expect(normalizeRemoteCwd({ host: '', cwd: '/srv' })).toBeNull()
    expect(normalizeRemoteCwd({ host: 'db', cwd: 'srv' })).toBeNull()
    expect(normalizeRemoteCwd({ host: 'db', cwd: '/a/../b' })).toBeNull()
    expect(normalizeRemoteCwd('db:/srv')).toBeNull()
    expect(normalizeRemoteCwd(undefined)).toBeNull()
  })
})

describe('replies from an extension', () => {
  it('SSH-C63 keeps plain names once, drops the rest and cuts a long listing', () => {
    expect(
      normalizeRemoteListing({
        ok: true,
        entries: [
          { name: 'a.txt', dir: false },
          { name: 'src', dir: true },
          { name: 'a.txt', dir: true },
          { name: 'x/y', dir: false },
          { name: '..', dir: true },
          { name: '.', dir: true },
          { name: '', dir: false },
          { name: 'bell\u0007', dir: false },
          { name: 'bad�bytes', dir: false },
          { name: 'n'.repeat(300), dir: false },
          { name: 5 },
          null,
          'text',
          { name: 'kind', dir: 'yes' },
        ],
      }),
    ).toEqual({
      ok: true,
      entries: [
        { name: 'a.txt', dir: false },
        { name: 'src', dir: true },
        { name: 'kind', dir: false },
      ],
      truncated: false,
    })
    const many = Array.from({ length: 6000 }, (_, i) => ({ name: `f${i}`, dir: false }))
    const cut = normalizeRemoteListing({ ok: true, entries: many })
    expect(cut.ok && cut.entries.length).toBe(REMOTE_ENTRIES_MAX)
    expect(cut.ok && cut.truncated).toBe(true)
    expect(normalizeRemoteListing({ ok: true, entries: 'no' })).toEqual({
      ok: false,
      error: 'failed',
    })
  })

  it('SSH-C63 refuses content with NUL, oversize content and a version that is not a token', () => {
    expect(normalizeRemoteRead({ ok: true, content: 'héllo', version: '12-6' })).toEqual({
      ok: true,
      content: 'héllo',
      version: '12-6',
    })
    expect(normalizeRemoteRead({ ok: true, content: 'a\u0000b', version: '1-3' })).toEqual({
      ok: false,
      error: 'binary',
    })
    expect(
      normalizeRemoteRead({
        ok: true,
        content: 'x'.repeat(REMOTE_FILE_MAX_BYTES + 1),
        version: '1-3',
      }),
    ).toEqual({ ok: false, error: 'too-large' })
    expect(
      normalizeRemoteRead({
        ok: true,
        content: '好'.repeat(REMOTE_FILE_MAX_BYTES / 3 + 1),
        version: '1-3',
      }),
    ).toEqual({ ok: false, error: 'too-large' })
    expect(normalizeRemoteRead({ ok: true, content: 'x', version: 'has space' })).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(normalizeRemoteRead({ ok: true, content: 7, version: '1-1' })).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(normalizeRemoteWrite({ ok: true, version: '9-9' })).toEqual({ ok: true, version: '9-9' })
    expect(normalizeRemoteWrite({ ok: true, version: '<script>' })).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(normalizeRemoteStat({ ok: true, kind: 'file', version: '1-1' })).toEqual({
      ok: true,
      kind: 'file',
      version: '1-1',
    })
    expect(normalizeRemoteStat({ ok: true, kind: 'file', version: 'a b' })).toEqual({
      ok: true,
      kind: 'file',
    })
    expect(normalizeRemoteStat({ ok: true, kind: 'dir', version: '1-1' })).toEqual({
      ok: true,
      kind: 'dir',
    })
    expect(normalizeRemoteStat({ ok: true, kind: 'socket' })).toEqual({
      ok: false,
      error: 'failed',
    })
  })

  it('passes a known error through and turns anything else into failed', () => {
    expect(normalizeRemoteRead({ ok: false, error: 'not-found' })).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(normalizeRemoteRead({ ok: false, error: '<b>boom</b>' })).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(normalizeRemoteListing(null)).toEqual({ ok: false, error: 'failed' })
    expect(normalizeRemoteWrite('ok')).toEqual({ ok: false, error: 'failed' })
  })

  it('counts UTF-8 bytes like an encoder', () => {
    for (const text of ['', 'abc', 'é', '好', '😀', 'a😀好é']) {
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length)
    }
  })
})
