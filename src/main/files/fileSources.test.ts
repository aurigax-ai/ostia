import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BrowseHarness, browseHarness } from '../../../test/browseHarness'
import { zipOf } from '../../../test/fixtures/archives/archives'
import { zip } from '../../extensions/archives/zip'
import { archiveRoot } from '../../shared/archives/archivePaths'
import { Archives } from './archives/archives'
import { FileSources, localSource } from './fileSources'

let dir: string
let sources: FileSources
let harness: BrowseHarness

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'file-sources-')))
  harness = browseHarness({
    providers: { 'archives.zip': zip },
    candidates: [
      {
        extId: 'archives',
        builtin: true,
        kind: { id: 'archives.zip', selector: [{ filenamePattern: '*.zip' }] },
      },
    ],
  })
  const confine = (path: string): string | null => (path.startsWith(`${dir}/`) ? path : null)
  sources = new FileSources(
    localSource(
      () => [dir],
      confine,
      () => harness.browse.browsable(),
    ),
    [new Archives(confine, harness.browse)],
  )
})

afterEach(() => {
  harness.dispose()
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
    writeFileSync(join(dir, 'plain.tar'), 'not browsable here')
    expect(await local.list(dir)).toEqual([
      { name: 'sub', dir: true },
      { name: 'bundle.zip', dir: false, archive: true },
      { name: 'note.txt', dir: false },
      { name: 'plain.tar', dir: false },
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

  it('reads byte ranges from the disk and leaves an archive entry to full reads', async () => {
    const path = join(dir, 'clip.bin')
    writeFileSync(path, '0123456789')
    const zip = join(dir, 'bundle.zip')
    writeFileSync(zip, zipOf([{ name: 'inside.txt', data: 'packed' }]))
    const read = sources.of(path).readRange
    const res = await read?.(path, 2, 4)
    if (!res?.ok) throw new Error('no range')
    expect(res.reader.size).toBe(10)
    expect(Buffer.from((await res.reader.read()) ?? []).toString()).toBe('234')
    await res.reader.close()
    expect(sources.of(`${archiveRoot(zip)}/inside.txt`).readRange).toBeUndefined()
  })
})
