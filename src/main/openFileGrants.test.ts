import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OpenFileGrants } from './openFileGrants'

const HUMAN = { sandboxed: false, remember: true }

let base: string
let home: string
let outside: string
let store: string

function grants(max?: number): OpenFileGrants {
  return new OpenFileGrants({ roots: () => [home], file: store, max })
}

function remembered(): string[] {
  return (JSON.parse(readFileSync(store, 'utf8')) as { paths: string[] }).paths
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pine-open-grants-')))
  home = join(base, 'home')
  outside = join(base, 'outside')
  store = join(base, 'data', 'opened-files.json')
  mkdirSync(home)
  mkdirSync(outside)
  mkdirSync(join(outside, 'folder'))
  writeFileSync(join(home, 'notes.md'), 'home')
  writeFileSync(join(outside, 'app.log'), 'log')
  writeFileSync(join(outside, 'other.log'), 'other')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('OpenFileGrants.admit', () => {
  it('opens a file outside every root and lets the viewer read exactly that file', () => {
    const g = grants()
    const file = join(outside, 'app.log')
    expect(g.confine(file)).toBeNull()

    expect(g.admit(file, HUMAN)).toEqual({ ok: true, path: file })

    expect(g.confine(file)).toBe(file)
    expect(g.confine(join(outside, 'other.log'))).toBeNull()
    expect(g.confine(outside)).toBeNull()
  })

  it('passes a file inside a root through without granting or resolving it', () => {
    const g = grants()
    symlinkSync(join(home, 'notes.md'), join(home, 'link.md'))

    expect(g.admit(join(home, 'link.md'), HUMAN)).toEqual({ ok: true, path: join(home, 'link.md') })
    expect(g.admit(join(home, 'new.md'), HUMAN)).toEqual({ ok: true, path: join(home, 'new.md') })
    expect(() => readFileSync(store)).toThrow()
  })

  it('grants the file a symlink points to, never the link', () => {
    const g = grants()
    const link = join(outside, 'latest.log')
    symlinkSync(join(outside, 'app.log'), link)

    expect(g.admit(link, HUMAN)).toEqual({ ok: true, path: join(outside, 'app.log') })

    expect(g.confine(link)).toBeNull()
    expect(g.confine(join(outside, 'app.log'))).toBe(join(outside, 'app.log'))
  })

  it('needs no grant when an outside link points into a root', () => {
    const g = grants()
    const link = join(outside, 'to-home.md')
    symlinkSync(join(home, 'notes.md'), link)

    expect(g.admit(link, HUMAN)).toEqual({ ok: true, path: join(home, 'notes.md') })
    expect(() => readFileSync(store)).toThrow()
  })

  it('refuses a folder, inside or outside the roots', () => {
    const g = grants()
    expect(g.admit(join(outside, 'folder'), HUMAN)).toEqual({
      ok: false,
      path: join(outside, 'folder'),
      error: 'directory',
    })
    expect(g.admit(home, HUMAN)).toEqual({ ok: false, path: home, error: 'directory' })
    expect(g.confine(join(outside, 'folder'))).toBeNull()
  })

  it('refuses a missing file, a dangling link and a relative path outside the roots', () => {
    const g = grants()
    symlinkSync(join(outside, 'gone'), join(outside, 'dangling'))

    expect(g.admit(join(outside, 'nope.txt'), HUMAN)).toMatchObject({ error: 'not-found' })
    expect(g.admit(join(outside, 'dangling'), HUMAN)).toMatchObject({ error: 'not-found' })
    expect(g.admit('app.log', HUMAN)).toMatchObject({ error: 'not-found' })
  })

  it('refuses a device and a file the user cannot read', () => {
    const g = grants()
    expect(g.admit('/dev/null', HUMAN)).toMatchObject({ ok: false, error: 'not-a-file' })

    const secret = join(outside, 'secret')
    writeFileSync(secret, 'x')
    chmodSync(secret, 0o000)
    const expected = process.getuid?.() === 0 ? { ok: true } : { ok: false, error: 'unreadable' }
    expect(g.admit(secret, HUMAN)).toMatchObject(expected)
  })

  it('refuses a sandboxed caller anything outside the roots and grants nothing', () => {
    const g = grants()
    const file = join(outside, 'app.log')

    expect(g.admit(file, { sandboxed: true, remember: true })).toEqual({
      ok: false,
      path: file,
      error: 'outside-sandbox',
    })
    expect(g.confine(file)).toBeNull()
    expect(g.admit(join(outside, 'nope'), { sandboxed: true, remember: true })).toMatchObject({
      error: 'outside-sandbox',
    })
    expect(g.admit(join(home, 'notes.md'), { sandboxed: true, remember: true })).toEqual({
      ok: true,
      path: join(home, 'notes.md'),
    })
  })
})

describe('OpenFileGrants.confine', () => {
  it('stops reading a granted path once it is no longer that regular file', () => {
    const g = grants()
    const file = join(outside, 'app.log')
    g.admit(file, HUMAN)

    renameSync(file, join(outside, 'moved.log'))
    symlinkSync(join(outside, 'other.log'), file)
    expect(g.confine(file)).toBeNull()

    rmSync(file)
    mkdirSync(file)
    expect(g.confine(file)).toBeNull()
  })

  it('resolves a ../ spelling to the granted file and nothing else', () => {
    const g = grants()
    g.admit(join(outside, 'app.log'), HUMAN)

    expect(g.confine(`${outside}/folder/../app.log`)).toBe(join(outside, 'app.log'))
    expect(g.confine(`${outside}/folder/../other.log`)).toBeNull()
  })
})

describe('OpenFileGrants persistence', () => {
  it('remembers a grant across restarts so a restored tab still reads', () => {
    const file = join(outside, 'app.log')
    grants().admit(file, HUMAN)

    expect(remembered()).toEqual([file])
    expect(grants().confine(file)).toBe(file)
  })

  it('keeps a scratch workspace grant in memory only', () => {
    const g = grants()
    const file = join(outside, 'app.log')
    g.admit(file, { sandboxed: false, remember: false })

    expect(g.confine(file)).toBe(file)
    expect(() => readFileSync(store)).toThrow()
    expect(grants().confine(file)).toBeNull()
  })

  it('saves only the newest grants past the cap and keeps the rest for this run', () => {
    const g = grants(1)
    const first = join(outside, 'app.log')
    const second = join(outside, 'other.log')
    g.admit(first, HUMAN)
    g.admit(second, HUMAN)

    expect(remembered()).toEqual([second])
    expect(g.confine(first)).toBe(first)
    expect(grants(1).confine(first)).toBeNull()
  })

  it('ignores a store that is not a list of absolute paths', () => {
    mkdirSync(join(base, 'data'))
    writeFileSync(store, JSON.stringify({ paths: ['relative.log', 7, join(outside, 'app.log')] }))
    const g = grants()

    expect(g.confine(join(outside, 'app.log'))).toBe(join(outside, 'app.log'))
    expect(g.confine(join(process.cwd(), 'relative.log'))).toBeNull()

    writeFileSync(store, '"nope"')
    expect(grants().confine(join(outside, 'app.log'))).toBeNull()
  })
})
