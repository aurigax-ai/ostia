import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zipOf } from '../../../test/fixtures/archives/archives'
import { archiveRoot } from '../../shared/archives/archivePaths'
import { Archives } from './archives/archives'
import { FileSources, localSource } from './fileSources'

let dir: string
let sources: FileSources

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'file-sources-')))
  const confine = (path: string): string | null => (path.startsWith(`${dir}/`) ? path : null)
  sources = new FileSources(
    localSource(() => [dir], confine),
    [new Archives(confine)],
  )
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FileSources', () => {
  it('answers a folder path from disk and an archive path from inside the archive', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'note.txt'), 'on disk')
    const zip = join(dir, 'bundle.zip')
    writeFileSync(zip, zipOf([{ name: 'inside.txt', data: 'packed' }]))
    const local = sources.of(dir)
    expect(local.watchable).toBe(true)
    expect(await local.list(dir)).toEqual([
      { name: 'sub', dir: true },
      { name: 'bundle.zip', dir: false, archive: true },
      { name: 'note.txt', dir: false },
    ])
    expect(await local.kind(join(dir, 'sub'))).toBe('dir')
    expect((await local.describe(join(dir, 'note.txt')))?.size).toBe(7)
    const entry = `${archiveRoot(zip)}/inside.txt`
    const inside = sources.of(entry)
    expect(inside).not.toBe(local)
    expect(inside.watchable).toBe(false)
    expect(await inside.readText(entry, 1024)).toMatchObject({ ok: true, text: 'packed' })
    expect((await inside.describe(entry))?.size).toBe(6)
  })

  it('refuses paths outside the roots in both sources', async () => {
    expect(await sources.of('/etc').list('/etc')).toEqual([])
    expect(await sources.of('/etc/hosts').kind('/etc/hosts')).toBeNull()
    const outside = `${archiveRoot('/etc/archive.zip')}/x`
    expect(await sources.of(outside).readBinary(outside, 1024)).toMatchObject({ ok: false })
  })
})
