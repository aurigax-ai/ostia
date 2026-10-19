import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExtensionStore,
  effectiveRecord,
  grantedCaps,
  kindApproved,
  needsApproval,
} from './extensionStore'

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
      approved: ALL_CAPABILITIES.filter((c) => c !== 'mcp' && c !== 'read-bus'),
    })
    expect(effectiveRecord(false, undefined)).toEqual({ enabled: false, approved: null })
    expect(effectiveRecord(true, undefined).approved).not.toContain('mcp')
    const saved = { enabled: false, approved: ['notify' as const] }
    expect(effectiveRecord(true, saved)).toBe(saved)
  })
})

describe('kindApproved', () => {
  const sheet = {
    id: 'acme.grid',
    selector: [{ filenamePattern: '*.XLSX' }, { filenamePattern: '*.ods' }],
    view: { priority: 'option' as const },
  }
  const claim = 'acme.grid:view:option:*.ods,*.xlsx'

  it('approves a built-in always, and a user kind only for the exact claim', () => {
    expect(kindApproved(true, undefined, sheet)).toBe(true)
    expect(kindApproved(false, undefined, sheet)).toBe(false)
    expect(kindApproved(false, { enabled: true, approved: [] }, sheet)).toBe(false)
    expect(
      kindApproved(false, { enabled: true, approved: [], approvedKinds: [claim] }, sheet),
    ).toBe(true)
  })

  it('waits for approval when an update widens the selector or adds a kind', () => {
    const record = { enabled: true, approved: [], approvedKinds: [claim] }
    const widened = { ...sheet, selector: [...sheet.selector, { filenamePattern: '*.csv' }] }
    expect(kindApproved(false, record, widened)).toBe(false)
    expect(kindApproved(false, record, { ...sheet, id: 'acme.other' })).toBe(false)
    expect(kindApproved(false, record, { ...sheet, view: { priority: 'default' } })).toBe(false)
  })
})

describe('ExtensionStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ostia-ext-store-'))
    dirs.push(d)
    return d
  }

  it('keeps the language servers the human switched off, and drops anything that is not a name', () => {
    const path = join(tmp(), 'extensions.json')
    new ExtensionStore(path).set('lsp', { enabled: true, approved: [], serversOff: ['pyright'] })
    expect(new ExtensionStore(path).get('lsp')).toEqual({
      enabled: true,
      approved: [],
      serversOff: ['pyright'],
    })
    writeFileSync(
      path,
      JSON.stringify({ lsp: { enabled: true, approved: [], serversOff: [1, 'ok', null] } }),
    )
    expect(new ExtensionStore(path).get('lsp')?.serversOff).toEqual(['ok'])
  })

  it('keeps the approved kind claims and drops anything that is not a short string', () => {
    const path = join(tmp(), 'extensions.json')
    new ExtensionStore(path).set('demo', {
      enabled: true,
      approved: [],
      approvedKinds: ['demo.grid:view:default:*.csv'],
    })
    expect(new ExtensionStore(path).get('demo')?.approvedKinds).toEqual([
      'demo.grid:view:default:*.csv',
    ])
    writeFileSync(
      path,
      JSON.stringify({
        demo: { enabled: true, approved: [], approvedKinds: [1, 'ok', 'x'.repeat(3000)] },
      }),
    )
    expect(new ExtensionStore(path).get('demo')?.approvedKinds).toEqual(['ok'])
  })

  it('persists records and reads them back in a new instance', () => {
    const path = join(tmp(), 'extensions.json')
    new ExtensionStore(path).set('demo', { enabled: true, approved: ['notify'] })
    expect(new ExtensionStore(path).get('demo')).toEqual({ enabled: true, approved: ['notify'] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      demo: { enabled: true, approved: ['notify'] },
    })
  })

  it('deletes a record so the extension needs approval again', () => {
    const path = join(tmp(), 'extensions.json')
    const store = new ExtensionStore(path)
    store.set('demo', { enabled: true, approved: ['notify'] })
    store.set('other', { enabled: false, approved: [] })
    store.delete('demo')
    expect(store.get('demo')).toBeUndefined()
    expect(new ExtensionStore(path).get('demo')).toBeUndefined()
    expect(new ExtensionStore(path).get('other')).toEqual({ enabled: false, approved: [] })
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
