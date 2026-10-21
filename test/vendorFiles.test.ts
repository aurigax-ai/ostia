import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyPackagePath } from '../marketplace/build-extension.mjs'

let root: string
let pkg: string
let out: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vendor-files-'))
  pkg = join(root, 'pkg')
  out = join(root, 'out')
  mkdirSync(join(pkg, 'data/nested'), { recursive: true })
  mkdirSync(out)
  writeFileSync(join(pkg, 'data/a.bin'), 'a')
  writeFileSync(join(pkg, 'data/nested/b.bin'), 'b')
  writeFileSync(join(root, 'secret.txt'), 'secret')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('copyPackagePath', () => {
  it('copies a folder and a file of the package to a path inside the extension', () => {
    copyPackagePath(pkg, ['data'], out, 'copied')
    expect(readFileSync(join(out, 'copied/nested/b.bin'), 'utf8')).toBe('b')
    copyPackagePath(pkg, ['data', 'a.bin'], out, 'licence/a.txt')
    expect(readFileSync(join(out, 'licence/a.txt'), 'utf8')).toBe('a')
  })

  it('refuses a source that leaves the package and one that is missing', () => {
    expect(() => copyPackagePath(pkg, ['..', 'secret.txt'], out, 'x', 'pkg/../secret.txt')).toThrow(
      'pkg/../secret.txt is not inside its package',
    )
    expect(() => copyPackagePath(pkg, ['nothing'], out, 'x', 'pkg/nothing')).toThrow(
      'not inside its package',
    )
  })

  it('refuses a target outside the extension or the extension folder itself', () => {
    expect(() => copyPackagePath(pkg, ['data'], out, '../escaped')).toThrow('outside the extension')
    expect(() => copyPackagePath(pkg, ['data'], out, '.')).toThrow('outside the extension')
  })

  it('refuses a link out of the package and never copies a link inside it', () => {
    symlinkSync(join(root, 'secret.txt'), join(pkg, 'data/leak'))
    expect(() => copyPackagePath(pkg, ['data', 'leak'], out, 'x')).toThrow('leaves its package')
    expect(() => copyPackagePath(pkg, ['data'], out, 'copied')).toThrow(
      'not a regular file or folder',
    )
  })
})
