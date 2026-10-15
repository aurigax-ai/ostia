import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeTrashPath, homeTrashPlace, topdirTrashPlace, trashInfo } from './freedesktopTrash'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ostia-trash-'))
  dirs.push(d)
  return d
}

const uid = process.getuid?.() ?? 0
const posix = process.platform !== 'win32'

describe('trash folder for another device', () => {
  it.runIf(posix)('uses $topdir/.Trash/$uid when .Trash is a sticky folder', async () => {
    const topdir = tmp()
    mkdirSync(join(topdir, '.Trash'))
    chmodSync(join(topdir, '.Trash'), 0o1777)
    const place = await topdirTrashPlace(topdir, uid, lstatSync(topdir).dev)
    expect(place).toEqual({ root: join(topdir, '.Trash', String(uid)), topdir })
    expect(lstatSync(join(place.root, 'files')).isDirectory()).toBe(true)
    expect(lstatSync(join(place.root, 'info')).isDirectory()).toBe(true)
    expect(lstatSync(place.root).mode & 0o777).toBe(0o700)
  })

  it.runIf(posix)(
    'falls back to $topdir/.Trash-$uid when .Trash is not sticky or is a link',
    async () => {
      const plain = tmp()
      mkdirSync(join(plain, '.Trash'))
      chmodSync(join(plain, '.Trash'), 0o777)
      expect(await topdirTrashPlace(plain, uid, lstatSync(plain).dev)).toEqual({
        root: join(plain, `.Trash-${uid}`),
        topdir: plain,
      })
      const linked = tmp()
      const elsewhere = tmp()
      chmodSync(elsewhere, 0o1777)
      symlinkSync(elsewhere, join(linked, '.Trash'))
      expect(await topdirTrashPlace(linked, uid, lstatSync(linked).dev)).toEqual({
        root: join(linked, `.Trash-${uid}`),
        topdir: linked,
      })
      expect(lstatSync(join(linked, `.Trash-${uid}`)).mode & 0o777).toBe(0o700)
    },
  )

  it.runIf(posix)('refuses a trash folder on another device than the item, or a link', async () => {
    const topdir = tmp()
    await expect(topdirTrashPlace(topdir, uid, lstatSync(topdir).dev + 1)).rejects.toThrow(
      'no-trash',
    )
    const linked = tmp()
    symlinkSync(tmp(), join(linked, `.Trash-${uid}`))
    await expect(topdirTrashPlace(linked, uid, lstatSync(linked).dev)).rejects.toThrow('no-trash')
  })

  it.runIf(posix)('uses the home trash only for an item on its device', async () => {
    const home = join(tmp(), 'Trash')
    const dev = lstatSync(tmpdir()).dev
    expect(await homeTrashPlace(home, lstatSync(join(home, '..')).dev)).toEqual({
      root: home,
      topdir: null,
    })
    expect(await homeTrashPlace(home, dev + 1)).toBeNull()
  })
})

describe('trashinfo', () => {
  it('percent-encodes the original path byte by byte and keeps slashes', () => {
    expect(encodeTrashPath('/home/u/my notes ü%.md')).toBe('/home/u/my%20notes%20%C3%BC%25.md')
    expect(encodeTrashPath('/a/b-c_d.e~f')).toBe('/a/b-c_d.e~f')
  })

  it('writes an absolute path for the home trash and a relative one for a device trash', () => {
    const at = new Date(2026, 9, 15, 9, 5, 7)
    expect(
      trashInfo('/home/u/a b.txt', { root: '/home/u/.local/share/Trash', topdir: null }, at),
    ).toBe('[Trash Info]\nPath=/home/u/a%20b.txt\nDeletionDate=2026-10-15T09:05:07\n')
    expect(
      trashInfo('/mnt/usb/docs/a.txt', { root: '/mnt/usb/.Trash-1000', topdir: '/mnt/usb' }, at),
    ).toBe('[Trash Info]\nPath=docs/a.txt\nDeletionDate=2026-10-15T09:05:07\n')
  })
})
