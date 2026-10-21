import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSION_MAX_FILES, parseMarketplaceManifest, planCopy } from './marketplaceManifest'

const CODE = 'abcdefghijklmnopqrstuvwx23'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ostia-marketplace-'))
  dirs.push(d)
  return d
}

describe('parseMarketplaceManifest', () => {
  it('accepts a name and a list of folders inside the repository', () => {
    expect(parseMarketplaceManifest({ name: 'Mine', extensions: ['a', 'tools/b', 'a'] })).toEqual({
      name: 'Mine',
      description: '',
      extensions: ['a', 'tools/b'],
      unlisted: [],
      history: [],
      revoked: [],
    })
  })

  it('accepts unlisted folders, each with its own install code', () => {
    const unlisted = [{ path: 'tools/c', code: CODE }]
    expect(parseMarketplaceManifest({ name: 'Mine', extensions: ['a'], unlisted })).toEqual({
      name: 'Mine',
      description: '',
      extensions: ['a'],
      unlisted,
      history: [],
      revoked: [],
    })
  })

  it('accepts the folders of older releases and the revoked versions', () => {
    const history = ['versions/a/1.0.0', 'versions/a/1.0.1', 'versions/a/1.0.0']
    const revoked = [{ id: 'abc', version: '1.0.1' }]
    expect(parseMarketplaceManifest({ name: 'Mine', extensions: ['a'], history, revoked })).toEqual(
      {
        name: 'Mine',
        description: '',
        extensions: ['a'],
        unlisted: [],
        history: ['versions/a/1.0.0', 'versions/a/1.0.1'],
        revoked,
      },
    )
  })

  it('refuses a history path outside the repository and a malformed revoked entry', () => {
    const base = { name: 'Mine', extensions: ['a'] }
    expect(parseMarketplaceManifest({ ...base, history: ['../x'] })).toMatch(/history\[0\]/)
    expect(parseMarketplaceManifest({ ...base, history: 'x' })).toMatch(/history/)
    expect(parseMarketplaceManifest({ ...base, revoked: [{ id: 'A', version: '1.0.0' }] })).toMatch(
      /revoked\[0\].id/,
    )
    expect(parseMarketplaceManifest({ ...base, revoked: [{ id: 'ab', version: '' }] })).toMatch(
      /revoked\[0\].version/,
    )
  })

  it('refuses an unlisted entry with a weak, shared or missing code, or a path listed twice', () => {
    const parse = (unlisted: unknown): unknown =>
      parseMarketplaceManifest({ name: 'x', extensions: ['a'], unlisted })
    expect(typeof parse('tools/c')).toBe('string')
    expect(typeof parse([{ path: 'tools/c' }])).toBe('string')
    expect(typeof parse([{ path: 'tools/c', code: 'keeper' }])).toBe('string')
    expect(typeof parse([{ path: '../c', code: CODE }])).toBe('string')
    expect(typeof parse([{ path: 'a', code: CODE }])).toBe('string')
    expect(
      typeof parse([
        { path: 'tools/c', code: CODE },
        { path: 'tools/d', code: CODE },
      ]),
    ).toBe('string')
  })

  it('refuses a missing name and paths that leave the repository', () => {
    expect(typeof parseMarketplaceManifest({ extensions: [] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: ['../out'] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: ['/etc'] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: ['.'] })).toBe('string')
    expect(typeof parseMarketplaceManifest({ name: 'x', extensions: 'a' })).toBe('string')
  })
})

describe('planCopy', () => {
  it('lists every regular file and skips the .git folder', () => {
    const dir = tmp()
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), '')
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'ostia.json'), '{}')
    writeFileSync(join(dir, 'lib', 'a.js'), '')
    const plan = planCopy(dir)
    expect(plan.ok && plan.files.sort()).toEqual(['lib/a.js', 'ostia.json'])
  })

  it('refuses a folder that holds a symlink', () => {
    const dir = tmp()
    symlinkSync('/etc/passwd', join(dir, 'passwd'))
    expect(planCopy(dir)).toEqual({ ok: false, error: 'invalid-extension' })
  })

  it('takes an extension that ships a language server with thousands of small files', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'server', 'stubs'), { recursive: true })
    for (let i = 0; i < 5500; i++) writeFileSync(join(dir, 'server', 'stubs', `s${i}.pyi`), '')
    const plan = planCopy(dir)
    expect(plan.ok && plan.files.length).toBe(5500)
  })

  it('refuses a folder with too many files', () => {
    const dir = tmp()
    for (let i = 0; i <= EXTENSION_MAX_FILES; i++) writeFileSync(join(dir, `f${i}`), '')
    expect(planCopy(dir)).toEqual({ ok: false, error: 'too-large' })
  })
})
