import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { expandHome, isPathAllowed, resolveSafe } from './pathGuard'

const root = mkdtempSync(join(tmpdir(), 'ostia-guard-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('expandHome', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir())
  })

  it('expands ~/x to <home>/x', () => {
    expect(expandHome('~/notes.txt')).toBe(join(homedir(), 'notes.txt'))
  })

  it('leaves paths without a leading ~ untouched', () => {
    expect(expandHome('/etc/passwd')).toBe('/etc/passwd')
    expect(expandHome('relative/x')).toBe('relative/x')
  })
})

describe('resolveSafe — rejections', () => {
  it('rejects a remote file address, which is never a local path', () => {
    expect(resolveSafe('remote://abcdef012345/etc/passwd', [process.cwd(), '/'])).toBeNull()
    expect(isPathAllowed('remote://abcdef012345/srv/app', ['/'])).toBe(false)
  })

  it('rejects an absolute path outside every root (/etc/passwd)', () => {
    expect(resolveSafe('/etc/passwd', [root])).toBeNull()
  })

  it('rejects an absolute .. escape that resolves outside the root', () => {
    const escapePath = join(root, '..', '..', 'etc', 'shadow')
    expect(resolveSafe(escapePath, [root])).toBeNull()
  })

  it('rejects a relative .. escape (../../etc/passwd resolves against cwd)', () => {
    expect(resolveSafe('../../etc/passwd', [root])).toBeNull()
  })

  it('rejects a sibling that merely shares a string prefix (boundary bug)', () => {
    const appRoot = join(root, 'app')
    const sibling = join(root, 'app-secrets', 'x')
    expect(resolveSafe(sibling, [appRoot])).toBeNull()
    expect(isPathAllowed(sibling, [appRoot])).toBe(false)
    expect(resolveSafe(appRoot, [appRoot])).toBe(appRoot)
    expect(resolveSafe(join(appRoot, 'main.ts'), [appRoot])).toBe(join(appRoot, 'main.ts'))
  })

  it('rejects a path that is inside NONE of several roots', () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    expect(resolveSafe('/etc/hosts', [a, b])).toBeNull()
    expect(isPathAllowed('/etc/hosts', [a, b])).toBe(false)
  })
})

describe('resolveSafe — acceptances', () => {
  it('allows the root itself', () => {
    expect(resolveSafe(root, [root])).toBe(root)
    expect(isPathAllowed(root, [root])).toBe(true)
  })

  it('allows a legitimate subpath of the root', () => {
    const target = join(root, 'src', 'a.ts')
    expect(resolveSafe(target, [root])).toBe(target)
    expect(isPathAllowed(target, [root])).toBe(true)
  })

  it('expands ~ for an in-root path (roots = [homedir()])', () => {
    expect(resolveSafe('~/notes.txt', [homedir()])).toBe(join(homedir(), 'notes.txt'))
    expect(resolveSafe('~', [homedir()])).toBe(homedir())
  })

  it('allows a path inside ANY of several roots', () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    const target = join(b, 'deep', 'file.txt')
    expect(resolveSafe(target, [a, b])).toBe(target)
    expect(isPathAllowed(target, [a, b])).toBe(true)
  })
})

describe('resolveSafe — trailing slashes', () => {
  it('handles a trailing slash on the root without off-by-one', () => {
    const rootSlash = root + sep
    expect(resolveSafe(root, [rootSlash])).toBe(root)
    expect(resolveSafe(join(root, 'x.txt'), [rootSlash])).toBe(join(root, 'x.txt'))
    const appSlash = join(root, 'app') + sep
    expect(resolveSafe(join(root, 'app-secrets', 'x'), [appSlash])).toBeNull()
  })

  it('handles a trailing slash on the input path', () => {
    const target = join(root, 'sub')
    expect(resolveSafe(`${target}${sep}`, [root])).toBe(target)
  })
})
