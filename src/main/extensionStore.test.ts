import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALL_CAPABILITIES } from '../shared/capabilities'
import { ExtensionStore, effectiveRecord, grantedCaps, needsApproval } from './extensionStore'

describe('grantedCaps', () => {
  it('is the intersection of what the manifest declares and what the human approved', () => {
    expect(grantedCaps(['notify', 'browse', 'shell'], ['notify', 'shell', 'gateway'])).toEqual([
      'notify',
      'shell',
    ])
  })

  it('grants nothing when nothing was ever approved', () => {
    expect(grantedCaps(['notify'], null)).toEqual([])
    expect(grantedCaps(['notify'], [])).toEqual([])
  })
})

describe('needsApproval / effectiveRecord', () => {
  it('asks the human only for a user extension that has never been reviewed', () => {
    expect(needsApproval(false, undefined)).toBe(true)
    expect(needsApproval(false, { enabled: false, approved: null })).toBe(true)
    expect(needsApproval(false, { enabled: false, approved: [] })).toBe(false)
    expect(needsApproval(true, undefined)).toBe(false)
  })

  it('pre-approves and enables built-ins, and keeps user extensions off by default', () => {
    expect(effectiveRecord(true, undefined)).toEqual({
      enabled: true,
      approved: [...ALL_CAPABILITIES],
    })
    expect(effectiveRecord(false, undefined)).toEqual({ enabled: false, approved: null })
    const saved = { enabled: false, approved: ['notify' as const] }
    expect(effectiveRecord(true, saved)).toBe(saved)
  })
})

describe('ExtensionStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'pine-ext-store-'))
    dirs.push(d)
    return d
  }

  it('persists records and reads them back in a new instance', () => {
    const path = join(tmp(), 'extensions.json')
    new ExtensionStore(path).set('demo', { enabled: true, approved: ['notify'] })
    expect(new ExtensionStore(path).get('demo')).toEqual({ enabled: true, approved: ['notify'] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      demo: { enabled: true, approved: ['notify'] },
    })
  })

  it('drops unknown capabilities and ignores prototype keys in a hand-edited file', () => {
    const path = join(tmp(), 'extensions.json')
    writeFileSync(
      path,
      '{"demo":{"enabled":true,"approved":["notify","root"]},"__proto__":{"enabled":true,"approved":[]}}',
    )
    const store = new ExtensionStore(path)
    expect(store.get('demo')).toEqual({ enabled: true, approved: ['notify'] })
    expect(store.get('toString')).toBeUndefined()
    expect(({} as Record<string, unknown>).enabled).toBeUndefined()
  })

  it('returns undefined for an unknown id and survives a corrupt file', () => {
    const path = join(tmp(), 'extensions.json')
    writeFileSync(path, 'not json')
    expect(new ExtensionStore(path).get('demo')).toBeUndefined()
  })
})
