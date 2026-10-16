import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atTransferFs } from './atTransferFs'
import { openAnchor } from './folderAnchor'
import { macAt } from './macAt'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(process.platform === 'darwin')('macAt', () => {
  async function held() {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-macat-'))
    dirs.push(dir)
    const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY)
    return { dir, handle }
  }

  it('lists, reads links and reports errno codes relative to a held folder', async () => {
    const { dir, handle } = await held()
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      mkdirSync(join(dir, 'sub'))
      symlinkSync('a.txt', join(dir, 'link'))
      expect((await macAt.list(handle.fd)).sort()).toEqual(['a.txt', 'link', 'sub'])
      expect(await macAt.readlinkat(handle.fd, 'link')).toBe('a.txt')
      expect((await macAt.lstatat(handle.fd, 'link')).isSymbolicLink()).toBe(true)
      await expect(macAt.mkdirat(handle.fd, 'sub')).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(macAt.lstatat(handle.fd, 'missing')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await macAt.pathOf(handle.fd)).toBe(await realpath(dir))
    } finally {
      await handle.close()
    }
  })

  it('reads a long link target whole', async () => {
    const { dir, handle } = await held()
    try {
      const target = 'a'.repeat(900)
      symlinkSync(target, join(dir, 'long'))
      expect(await macAt.readlinkat(handle.fd, 'long')).toBe(target)
    } finally {
      await handle.close()
    }
  })

  it('anchors a folder named in another case on a case-insensitive volume', async () => {
    const { dir, handle } = await held()
    await handle.close()
    const real = await realpath(dir)
    const swapped = real.replace(/[a-z]+-[A-Za-z0-9]+$/, (tail) => tail.toUpperCase())
    if (swapped === real || !existsSync(swapped)) return
    const anchor = await openAnchor(atTransferFs(macAt), swapped, 'darwin')
    await anchor.close()
  })

  it('keeps acting on the held folder after it is swapped for a link', async () => {
    const { dir, handle } = await held()
    const outside = mkdtempSync(join(tmpdir(), 'ostia-macat-out-'))
    dirs.push(outside)
    try {
      renameSync(dir, `${dir}-real`)
      symlinkSync(outside, dir)
      dirs.push(`${dir}-real`)
      await macAt.mkdirat(handle.fd, 'made')
      expect(await macAt.list(handle.fd)).toEqual(['made'])
      expect(readdirSync(outside)).toEqual([])
    } finally {
      await handle.close()
    }
  })
})
