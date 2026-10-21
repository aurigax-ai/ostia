import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeTrashPath,
  homeTrashPlace,
  topdirTrashPlace,
  trashedName,
  trashInfo,
} from './freedesktopTrash'
import { isSystemInternal, mountAllowsTrash, parseMountInfo, userMountAt } from './trashMounts'

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

function asMount(dir: string): (topdir: string) => Promise<boolean> {
  return async (topdir) => mountAllowsTrash(`40 1 8:1 / ${dir} rw - ext4 /dev/sdb1 rw`, topdir)
}
const posix = process.platform !== 'win32'

describe('trash folder for another device', () => {
  it.runIf(posix)('uses $topdir/.Trash/$uid when .Trash is a sticky folder', async () => {
    const topdir = tmp()
    mkdirSync(join(topdir, '.Trash'))
    chmodSync(join(topdir, '.Trash'), 0o1777)
    const place = await topdirTrashPlace(topdir, uid, lstatSync(topdir).dev, asMount(topdir))
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
      expect(await topdirTrashPlace(plain, uid, lstatSync(plain).dev, asMount(plain))).toEqual({
        root: join(plain, `.Trash-${uid}`),
        topdir: plain,
      })
      const linked = tmp()
      const elsewhere = tmp()
      chmodSync(elsewhere, 0o1777)
      symlinkSync(elsewhere, join(linked, '.Trash'))
      expect(await topdirTrashPlace(linked, uid, lstatSync(linked).dev, asMount(linked))).toEqual({
        root: join(linked, `.Trash-${uid}`),
        topdir: linked,
      })
      expect(lstatSync(join(linked, `.Trash-${uid}`)).mode & 0o777).toBe(0o700)
    },
  )

  it.runIf(posix)('refuses a trash folder on another device than the item, or a link', async () => {
    const topdir = tmp()
    await expect(
      topdirTrashPlace(topdir, uid, lstatSync(topdir).dev + 1, asMount(topdir)),
    ).rejects.toThrow('no-trash')
    const linked = tmp()
    symlinkSync(tmp(), join(linked, `.Trash-${uid}`))
    await expect(
      topdirTrashPlace(linked, uid, lstatSync(linked).dev, asMount(linked)),
    ).rejects.toThrow('no-trash')
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

describe('mounts that may hold a Trash', () => {
  it('parses mountinfo, unescaping the mount point and source', () => {
    expect(
      parseMountInfo(
        '36 1 8:1 / /mnt/my\\040usb rw,relatime shared:1 - vfat /dev/sdb1 rw\n37 1 0:5 / /dev/shm rw - tmpfs tmpfs rw\n',
      ),
    ).toEqual([
      { mountPoint: '/mnt/my usb', fsType: 'vfat', source: '/dev/sdb1' },
      { mountPoint: '/dev/shm', fsType: 'tmpfs', source: 'tmpfs' },
    ])
  })

  it('follows glib: system file systems, paths and devices have no Trash, user drives do', () => {
    const at = (mountPoint: string, fsType = 'ext4', source = '/dev/sdb1') => ({
      mountPoint,
      fsType,
      source,
    })
    for (const mount of [
      at('/media/u/stick', 'tmpfs'),
      at('/tmp'),
      at('/home'),
      at('/run'),
      at('/dev/shm'),
      at('/sys/fs/x'),
      at('/srv/x/.gvfs'),
      at('/snap/core/1', 'squashfs', '/dev/loop3'),
    ]) {
      expect(isSystemInternal(mount), mount.mountPoint).toBe(true)
    }
    for (const mount of [at('/run/media/u/USB'), at('/mnt/data'), at('/media/u/stick', 'vfat')]) {
      expect(isSystemInternal(mount), mount.mountPoint).toBe(false)
    }
  })

  it('finds a Trash only at a listed mount point, never at a folder below one', () => {
    const mounts = parseMountInfo('40 1 8:1 / /mnt/data rw - btrfs /dev/sdb1 rw\n')
    expect(userMountAt(mounts, '/mnt/data')).toMatchObject({ mountPoint: '/mnt/data' })
    expect(userMountAt(mounts, '/mnt/data/subvolume')).toBeNull()
  })
})

describe('trash-side names', () => {
  it('keeps short names and shortens long ones to fit with .trashinfo and a counter', () => {
    expect(trashedName('notes.md', 1)).toBe('notes.md')
    expect(trashedName('notes.md', 3)).toBe('notes.md.3')
    const long = 'ü'.repeat(200)
    const short = trashedName(long, 1)
    expect(Buffer.byteLength(`${trashedName(long, 999)}.trashinfo`)).toBeLessThanOrEqual(255)
    expect(long.startsWith(short)).toBe(true)
    expect(short.endsWith('�')).toBe(false)
  })
})
