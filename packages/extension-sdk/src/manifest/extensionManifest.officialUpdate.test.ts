import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverExtensions, OFFICIAL_UPDATE_PENDING, parseManifest } from './extensionManifest'

function manifest(version: string, api = '7.0'): Record<string, unknown> {
  return { id: 'csv', name: 'csv', version, api, main: 'main.js' }
}

function root(entries: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'official-update-'))
  for (const [name, raw] of Object.entries(entries)) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'ostia.json'), JSON.stringify(raw))
  }
  return dir
}

function discover(update: string, trusted: string | null) {
  const roots = [
    { dir: root({ csv: manifest('1.0.0') }), builtin: true },
    { dir: root({ csv: manifest(update) }), builtin: false },
  ]
  const errors: string[] = []
  const found = discoverExtensions(
    roots,
    (_dir, error) => errors.push(error),
    () => trusted,
  )
  return { found, errors, update: roots[1]?.dir }
}

describe('a built-in updated from the official marketplace', () => {
  it('is replaced by a trusted newer copy, which keeps the built-in powers', () => {
    const { found, errors, update } = discover('1.2.0', null)
    expect(errors).toEqual([])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ builtin: true, dir: join(update as string, 'csv') })
    expect(found[0]?.manifest.version).toBe('1.2.0')
  })

  it('keeps the bundled copy when the check refuses the other one', () => {
    const { found, errors } = discover('1.2.0', 'the signature does not match')
    expect(found[0]?.manifest.version).toBe('1.0.0')
    expect(errors).toEqual([
      expect.stringContaining(
        "not used in place of the built-in 'csv': the signature does not match",
      ),
    ])
  })

  it('leaves the built-in out of the scan while the check is still verifying the copy', () => {
    const roots = [
      { dir: root({ csv: manifest('1.0.0') }), builtin: true },
      { dir: root({ csv: manifest('1.2.0') }), builtin: false },
    ]
    const errors: string[] = []
    const found = discoverExtensions(
      roots,
      (_dir, error) => errors.push(error),
      () => OFFICIAL_UPDATE_PENDING,
    )
    expect(found).toEqual([])
    expect(errors).toEqual([])
  })

  it('refuses a copy below the bundled version even when it is trusted', () => {
    const { found, errors } = discover('0.9.0', null)
    expect(found[0]?.manifest.version).toBe('1.0.0')
    expect(errors[0]).toContain('version 0.9.0 is below the bundled 1.0.0')
  })

  it('refuses a copy that claims more than the bundled one, whatever the check says', () => {
    const roots = [
      { dir: root({ csv: manifest('1.0.0') }), builtin: true },
      { dir: root({ csv: { ...manifest('1.1.0'), capabilities: ['notify'] } }), builtin: false },
    ]
    const errors: string[] = []
    const found = discoverExtensions(
      roots,
      (_dir, error) => errors.push(error),
      () => null,
    )
    expect(found[0]?.manifest.version).toBe('1.0.0')
    expect(errors[0]).toContain('asks for notify')
  })

  it('refuses every other copy by default', () => {
    const roots = [
      { dir: root({ csv: manifest('1.0.0') }), builtin: true },
      { dir: root({ csv: manifest('2.0.0') }), builtin: false },
    ]
    const errors: string[] = []
    const found = discoverExtensions(roots, (_dir, error) => errors.push(error))
    expect(found[0]?.manifest.version).toBe('1.0.0')
    expect(errors[0]).toContain('no official update channel')
  })
})

describe('parseManifest with anyApi', () => {
  it('reads a manifest that needs a newer API but still refuses a malformed one', () => {
    const newer = manifest('1.0.0', '99.0')
    expect(parseManifest(newer, '/x')).toMatchObject({ ok: false })
    expect(parseManifest(newer, '/x', { anyApi: true })).toMatchObject({ ok: true })
    expect(parseManifest(manifest('1.0.0', 'new'), '/x', { anyApi: true })).toMatchObject({
      ok: false,
    })
  })
})
