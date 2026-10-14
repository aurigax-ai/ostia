import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isSameFolder } from './sameFolder'

describe('isSameFolder', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'same-folder-')))
  const home = join(base, 'home')
  const proj = join(home, 'proj')
  mkdirSync(join(proj, 'src'), { recursive: true })
  symlinkSync(proj, join(base, 'link'))

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('compares real paths, with ~ as the home folder', () => {
    expect(isSameFolder(proj, `${proj}/`, home)).toBe(true)
    expect(isSameFolder('~/proj', join(base, 'link'), home)).toBe(true)
    expect(isSameFolder(proj, join(proj, 'src', '..'), home)).toBe(true)
  })

  it('tells a subfolder, a parent and a relative path apart', () => {
    expect(isSameFolder(proj, join(proj, 'src'), home)).toBe(false)
    expect(isSameFolder(proj, home, home)).toBe(false)
    expect(isSameFolder('proj', proj, home)).toBe(false)
  })
})
