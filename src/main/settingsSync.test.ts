import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SETTINGS_LOCAL_ONLY_KEYS,
  SettingsSync,
  canonicalJson,
  conflictName,
  expandSyncDir,
  hashOf,
  mergeIntoLocal,
  planSync,
  syncedPart,
} from './settingsSync'

describe('planSync', () => {
  const side = (hash: string | null, mtimeMs = 0) => ({ hash, mtimeMs })

  it('does nothing when neither side exists', () => {
    expect(planSync(side(null), side(null), null)).toEqual({ kind: 'noop' })
  })

  it('pushes when only the local copy exists', () => {
    expect(planSync(side('a'), side(null), null)).toEqual({ kind: 'push' })
  })

  it('pulls when only the remote copy exists', () => {
    expect(planSync(side(null), side('a'), null)).toEqual({ kind: 'pull' })
  })

  it('does nothing when both sides already match', () => {
    expect(planSync(side('a'), side('a'), null)).toEqual({ kind: 'noop' })
  })

  it('pushes when only the local copy changed since the last sync', () => {
    expect(planSync(side('b', 1), side('a', 99), 'a')).toEqual({ kind: 'push' })
  })

  it('pulls when only the remote copy changed since the last sync', () => {
    expect(planSync(side('a', 99), side('b', 1), 'a')).toEqual({ kind: 'pull' })
  })

  it('picks the newer side when both changed since the last sync', () => {
    expect(planSync(side('b', 10), side('c', 20), 'a')).toEqual({
      kind: 'conflict',
      winner: 'remote',
    })
    expect(planSync(side('b', 30), side('c', 20), 'a')).toEqual({
      kind: 'conflict',
      winner: 'local',
    })
  })

  it('treats a first sync with two different copies as a conflict', () => {
    expect(planSync(side('b', 10), side('c', 5), null)).toEqual({
      kind: 'conflict',
      winner: 'local',
    })
  })
})

describe('sync helpers', () => {
  it('hashes objects independently of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, 2] } })).toBe('{"a":{"c":[1,2],"d":2},"b":1}')
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }))
  })

  it('keeps local-only keys from the local copy and drops them from the remote copy', () => {
    const merged = mergeIntoLocal(
      { locale: 'en', sync: { dir: '/a' }, capabilities: { grants: ['shell'] } },
      { locale: 'zh-Hant', sync: { dir: '/evil' }, capabilities: { grants: ['all-workspaces'] } },
      ['sync', 'capabilities'],
    )
    expect(merged).toEqual({
      locale: 'zh-Hant',
      sync: { dir: '/a' },
      capabilities: { grants: ['shell'] },
    })
  })

  it('SBX-C16 never carries the sandbox policy to or from the sync folder', () => {
    const local = { locale: 'en', sandbox: { allowedDomains: ['api.github.com'] } }
    expect(syncedPart(local, SETTINGS_LOCAL_ONLY_KEYS)).toEqual({ locale: 'en' })
    const merged = mergeIntoLocal(
      local,
      { locale: 'en', sandbox: { allowedDomains: ['*.evil.example'] } },
      SETTINGS_LOCAL_ONLY_KEYS,
    )
    expect(merged.sandbox).toEqual({ allowedDomains: ['api.github.com'] })
  })

  it('names conflict copies with a filesystem-safe time and host', () => {
    expect(conflictName('settings.json', new Date('2026-09-28T10:11:12.345Z'), 'my host')).toBe(
      'settings.conflict-2026-09-28T10-11-12-345Z-my_host.json',
    )
  })

  it('accepts only absolute or home-relative sync dirs', () => {
    expect(expandSyncDir('relative/dir')).toBeNull()
    expect(expandSyncDir('')).toBeNull()
    expect(expandSyncDir(42)).toBeNull()
    expect(expandSyncDir('/tmp/x/../y')).toBe('/tmp/y')
    expect(expandSyncDir('~/sync')?.endsWith('/sync')).toBe(true)
  })
})

describe('SettingsSync', () => {
  let root: string
  let local: string
  let remote: string
  let clock: Date

  const writeJson = (path: string, value: unknown, mtimeSec?: number): void => {
    writeFileSync(path, JSON.stringify(value, null, 2))
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
  }
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
  const settings = (extra: Record<string, unknown>) => ({ sync: { dir: remote }, ...extra })
  const make = () => new SettingsSync({ userData: local, host: 'box', now: () => clock })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pine-sync-'))
    local = join(root, 'local')
    remote = join(root, 'remote')
    mkdirSync(local)
    mkdirSync(remote)
    clock = new Date('2026-09-28T10:00:00.000Z')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('is off and touches nothing when no sync dir is set', () => {
    writeJson(join(local, 'settings.json'), { locale: 'en' })
    const res = make().run()
    expect(res.status.state).toBe('off')
    expect(readdirSync(remote)).toEqual([])
  })

  it('pushes settings on the first sync without the local-only keys', () => {
    writeJson(
      join(local, 'settings.json'),
      settings({ locale: 'en', capabilities: { grants: ['shell'] } }),
    )
    writeJson(join(local, 'extensions.json'), { hello: { enabled: true, approved: [] } })
    const res = make().run()
    expect(res.status).toMatchObject({ state: 'ok', dir: remote, lastConflict: null })
    expect(res.status.lastSync).toBe(clock.toISOString())
    expect(readJson(join(remote, 'settings.json'))).toEqual({ locale: 'en' })
    expect(readJson(join(remote, 'extensions.json'))).toEqual({
      hello: { enabled: true, approved: [] },
    })
    expect(res.pulled).toEqual([])
  })

  it('pulls a remote change and keeps local-only keys', () => {
    writeJson(
      join(local, 'settings.json'),
      settings({ locale: 'en', capabilities: { grants: ['shell'] } }),
    )
    const sync = make()
    sync.run()
    writeJson(join(remote, 'settings.json'), {
      locale: 'zh-Hant',
      capabilities: { grants: ['all-workspaces'] },
      sync: { dir: '/elsewhere' },
    })
    const res = sync.run()
    expect(res.pulled).toEqual(['settings.json'])
    expect(readJson(join(local, 'settings.json'))).toEqual({
      locale: 'zh-Hant',
      sync: { dir: remote },
      capabilities: { grants: ['shell'] },
    })
  })

  it('pushes a local change made after the last sync', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    const sync = make()
    sync.run()
    writeJson(join(local, 'settings.json'), settings({ locale: 'zh-Hant' }))
    const res = sync.run()
    expect(res.pulled).toEqual([])
    expect(readJson(join(remote, 'settings.json'))).toEqual({ locale: 'zh-Hant' })
  })

  it('does nothing when only local-only keys changed', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    const sync = make()
    sync.run()
    writeJson(
      join(local, 'settings.json'),
      settings({ locale: 'en', capabilities: { grants: ['shell'] } }),
    )
    const res = sync.run()
    expect(res.pulled).toEqual([])
    expect(readJson(join(remote, 'settings.json'))).toEqual({ locale: 'en' })
  })

  it('keeps the newer copy on a conflict and saves the other as a conflict copy', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    const sync = make()
    sync.run()
    writeJson(join(local, 'settings.json'), settings({ locale: 'en', behavior: { a: 1 } }), 1000)
    writeJson(join(remote, 'settings.json'), { locale: 'zh-Hant' }, 2000)
    clock = new Date('2026-09-28T11:00:00.000Z')
    const res = sync.run()
    const copy = 'settings.conflict-2026-09-28T11-00-00-000Z-box.json'
    expect(res.status.lastConflict).toEqual({ at: clock.toISOString(), files: [copy] })
    expect(res.pulled).toEqual(['settings.json'])
    expect(readJson(join(local, 'settings.json'))).toEqual(settings({ locale: 'zh-Hant' }))
    expect(readJson(join(remote, copy))).toEqual({ locale: 'en', behavior: { a: 1 } })
  })

  it('pushes the local copy on a conflict when it is newer', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    const sync = make()
    sync.run()
    writeJson(join(local, 'settings.json'), settings({ locale: 'zh-Hant' }), 3000)
    writeJson(join(remote, 'settings.json'), { locale: 'en', behavior: { b: 2 } }, 2000)
    const res = sync.run()
    expect(res.pulled).toEqual([])
    expect(readJson(join(remote, 'settings.json'))).toEqual({ locale: 'zh-Hant' })
    const copy = res.status.lastConflict?.files[0] ?? ''
    expect(readJson(join(remote, copy))).toEqual({ locale: 'en', behavior: { b: 2 } })
  })

  it('reports invalid JSON and overwrites neither side', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    writeFileSync(join(remote, 'settings.json'), '{ not json')
    const res = make().run()
    expect(res.status).toMatchObject({ state: 'error', error: 'invalid-json:settings.json' })
    expect(readFileSync(join(remote, 'settings.json'), 'utf8')).toBe('{ not json')
    expect(readJson(join(local, 'settings.json'))).toEqual(settings({ locale: 'en' }))
  })

  it('pulls extension choices from the sync folder', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    writeJson(join(remote, 'extensions.json'), { ports: { enabled: false, approved: ['notify'] } })
    const res = make().run()
    expect(res.pulled).toEqual(['extensions.json'])
    expect(readJson(join(local, 'extensions.json'))).toEqual({
      ports: { enabled: false, approved: ['notify'] },
    })
  })

  it('reports a missing sync folder without creating it', () => {
    rmSync(remote, { recursive: true })
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    const res = make().run()
    expect(res.status).toMatchObject({ state: 'error', error: 'missing' })
    expect(existsSync(remote)).toBe(false)
  })

  it('refuses to sync into its own settings folder', () => {
    writeJson(join(local, 'settings.json'), { sync: { dir: local }, locale: 'en' })
    expect(make().run().status).toMatchObject({ state: 'error', error: 'same-as-local' })
  })

  it('starts over when the sync folder changes', () => {
    writeJson(join(local, 'settings.json'), settings({ locale: 'en' }))
    const sync = make()
    sync.run()
    const other = join(root, 'other')
    mkdirSync(other)
    writeJson(join(other, 'settings.json'), { locale: 'zh-Hant' }, 1)
    writeJson(join(local, 'settings.json'), { sync: { dir: other }, locale: 'en' }, 5)
    const res = sync.run()
    expect(res.status.dir).toBe(other)
    expect(res.status.lastConflict?.files).toHaveLength(1)
    expect(readJson(join(other, 'settings.json'))).toEqual({ locale: 'en' })
  })
})
