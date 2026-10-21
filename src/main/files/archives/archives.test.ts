import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { BROWSE_LIMITS } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { XzCompressor } from '@napi-rs/lzma'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BrowseHarness, browseHarness } from '../../../../test/browseHarness'
import { tarOf, zerosDeflated, zipOf } from '../../../../test/fixtures/archives/archives'
import { DOCS_TAR } from '../../../../test/fixtures/archives/bzip2Data'
import { bz2 } from '../../../../test/fixtures/archives/bzip2Fixture'
import { archiveDecoders } from '../../../../test/fixtures/archives/decoders'
import { sevenZip } from '../../../extensions/archives/sevenZip'
import { tarProvider } from '../../../extensions/archives/tar'
import { zip } from '../../../extensions/archives/zip'
import { archiveRoot } from '../../../shared/archives/archivePaths'
import { Archives } from './archives'

const MIB = 1024 * 1024
let dir: string
let archives: Archives
let harness: BrowseHarness
const tar = tarProvider(archiveDecoders)

const ARCHIVE_KINDS = [
  {
    extId: 'archives',
    builtin: true,
    kind: {
      id: 'archives.zip',
      selector: [{ filenamePattern: '*.zip' }, { filenamePattern: '*.jar' }],
    },
  },
  {
    extId: 'archives',
    builtin: true,
    kind: { id: 'archives.sevenzip', selector: [{ filenamePattern: '*.7z' }] },
  },
  {
    extId: 'archives',
    builtin: true,
    kind: {
      id: 'archives.tar-xz',
      selector: [{ filenamePattern: '*.tar.xz' }, { filenamePattern: '*.txz' }],
    },
  },
  {
    extId: 'archives',
    builtin: true,
    kind: {
      id: 'archives.tar-bz2',
      selector: ['*.tar.bz2', '*.tbz2', '*.tbz'].map((filenamePattern) => ({ filenamePattern })),
    },
  },
  {
    extId: 'archives',
    builtin: true,
    kind: {
      id: 'archives.tar',
      selector: ['*.tar', '*.tgz', '*.tar.gz', '*.tzst', '*.tar.zst'].map((filenamePattern) => ({
        filenamePattern,
      })),
    },
  },
]

function archivesOver(limits = BROWSE_LIMITS): Archives {
  return new Archives((path) => (path.startsWith(`${dir}/`) ? path : null), harness.browse, limits)
}

function put(name: string, bytes: Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

async function text(path: string): Promise<string> {
  const read = await archives.readText(path, 4 * MIB)
  if (!read.ok) throw new Error(`not read: ${read.error}`)
  return read.text
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'archives-'))
  harness = browseHarness({
    providers: {
      'archives.zip': zip,
      'archives.tar': tar,
      'archives.tar-xz': tar,
      'archives.tar-bz2': tar,
      'archives.sevenzip': sevenZip,
    },
    candidates: ARCHIVE_KINDS,
  })
  archives = archivesOver()
})

afterEach(() => {
  harness.dispose()
  rmSync(dir, { recursive: true, force: true })
})

async function xz(bytes: Uint8Array): Promise<Buffer> {
  const compressor = new XzCompressor({ preset: 0 })
  return Buffer.concat([compressor.update(bytes), await compressor.finish()])
}

describe('Archives', () => {
  it('lists and opens a 7z through the browse protocol, refusing links, encrypted entries and what it cannot read', async () => {
    const seven = (name: string): string =>
      put(name, readFileSync(join(__dirname, '../../../../test/fixtures/archives/7z', name)))
    const root = archiveRoot(seven('lzma2.7z'))
    expect((await archives.list(`${root}/src`)).map((entry) => entry.name)).toEqual([
      'emptydir',
      'sub',
      'empty.txt',
      'a.txt',
      'link',
      'prog.exe',
    ])
    expect(await archives.list(`${root}/src`)).toContainEqual({
      name: 'link',
      dir: false,
      link: 'a.txt',
    })
    expect(await text(`${root}/src/a.txt`)).toBe('hello 7z\n'.repeat(40))
    expect(await text(`${root}/src/sub/b.txt`)).toBe('second file in a folder\n'.repeat(10))
    expect(await archives.readText(`${root}/src/link`, MIB)).toMatchObject({
      ok: false,
      reason: 'link',
    })
    const locked = archiveRoot(seven('contentenc.7z'))
    expect(await archives.readText(`${locked}/src/a.txt`, MIB)).toMatchObject({
      ok: false,
      reason: 'encrypted',
    })
    for (const name of ['headerenc.7z', 'bcj2.7z', 'ppmd.7z']) {
      expect(await archives.list(archiveRoot(seven(name))), name).toEqual([])
    }
  })

  it('lists and opens a tar.xz and a tar.bz2 like a tar.gz, and refuses compression inside them', async () => {
    const plain = DOCS_TAR
    const expected = [
      { name: 'docs', dir: true },
      { name: 'passwd', dir: false, link: '../../etc/passwd' },
    ]
    for (const [name, bytes] of [
      ['a.tar.xz', await xz(plain)],
      ['b.txz', await xz(plain)],
      ['c.tar.bz2', bz2('docs-link.tar.bz2')],
      ['d.tbz2', bz2('docs-link.tar.bz2')],
    ] as const) {
      const root = archiveRoot(put(name, bytes))
      expect(await archives.list(root), name).toEqual(expected)
      expect(await text(`${root}/docs/readme.txt`), name).toBe('hello')
      expect(await archives.readText(`${root}/passwd`, MIB), name).toMatchObject({
        ok: false,
        reason: 'link',
      })
    }
    for (const [name, nested] of [
      ['gz-in-xz.tar.xz', await xz(gzipSync(plain))],
      ['xz-in-gz.tar.gz', gzipSync(await xz(plain))],
      ['bz2-in-gz.tar.gz', gzipSync(bz2('docs-link.tar.bz2'))],
      ['gz-in-bz2.tar.bz2', bz2('gz-in-bz2.tar.bz2')],
      ['xz-in-xz.tar.xz', await xz(await xz(plain))],
    ] as const) {
      expect(await archives.list(archiveRoot(put(name, nested))), name).toEqual([])
    }
  })

  it('lists a zip and a tar.gz as the same tree and opens entries without extracting', async () => {
    const files = [
      { name: 'docs/readme.txt', data: 'hello' },
      { name: 'docs/deep/note.md', data: '# note' },
      { name: 'top.csv', data: 'a,b' },
    ]
    for (const path of [put('bundle.zip', zipOf(files)), put('bundle.tar.gz', tarOf(files))]) {
      const root = archiveRoot(path)
      expect(await archives.list(root), path).toEqual([
        { name: 'docs', dir: true },
        { name: 'top.csv', dir: false },
      ])
      expect(await archives.list(`${root}/docs`), path).toEqual([
        { name: 'deep', dir: true },
        { name: 'readme.txt', dir: false },
      ])
      expect(await archives.kind(`${root}/docs`)).toBe('dir')
      expect(await archives.kind(`${root}/top.csv`)).toBe('file')
      expect(await text(`${root}/docs/deep/note.md`)).toBe('# note')
    }
    expect(readdirSync(dir).sort()).toEqual(['bundle.tar.gz', 'bundle.zip'])
  })

  it('shows traversal names literally and never reads or writes a real path', async () => {
    const path = put(
      'evil.zip',
      zipOf([
        { name: '../../etc/passwd', data: 'inside one' },
        { name: '/abs/file', data: 'inside two' },
        { name: 'C:\\x', data: 'inside three' },
        { name: 'bell\u0007.txt', data: 'inside four' },
      ]),
    )
    const root = archiveRoot(path)
    const names = (await archives.list(root)).map((entry) => entry.name)
    expect(names).toEqual(['..', 'abs', 'C:', 'bell\\u0007.txt'])
    expect(await text(`${root}/../../etc/passwd`)).toBe('inside one')
    expect(await text(`${root}/abs/file`)).toBe('inside two')
    expect(await text(`${root}/C:/x`)).toBe('inside three')
    expect(readdirSync(dir)).toEqual(['evil.zip'])
    const tar = archiveRoot(
      put('evil.tar', tarOf([{ name: '../up.txt', data: 'tar inside' }], false)),
    )
    expect((await archives.list(tar)).map((entry) => entry.name)).toEqual(['..'])
    expect(await text(`${tar}/../up.txt`)).toBe('tar inside')
  })

  it('refuses a bomb entry by its declared size and by its real size', async () => {
    const path = put(
      'bomb.zip',
      zipOf([
        { name: 'big.bin', deflated: zerosDeflated(MIB), size: 1024 * MIB },
        { name: 'liar.bin', deflated: zerosDeflated(4 * MIB), size: 1024 },
      ]),
    )
    const root = archiveRoot(path)
    expect(await archives.readBinary(`${root}/big.bin`, MIB)).toEqual({
      ok: false,
      error: 'too-large',
      size: 1024 * MIB,
    })
    expect(await archives.readBinary(`${root}/liar.bin`, MIB)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'unzip-limit',
    })
  })

  it('shows links with their target and never follows them', async () => {
    const zip = archiveRoot(
      put('links.zip', zipOf([{ name: 'shadow', data: '/etc/shadow', mode: 0o120777 }])),
    )
    expect(await archives.list(zip)).toEqual([{ name: 'shadow', dir: false, link: '/etc/shadow' }])
    expect(await archives.readText(`${zip}/shadow`, MIB)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'link',
    })
    const tar = archiveRoot(
      put('links.tgz', tarOf([{ name: 'passwd', type: '2', link: '../../etc/passwd' }])),
    )
    expect(await archives.list(tar)).toEqual([
      { name: 'passwd', dir: false, link: '../../etc/passwd' },
    ])
    expect(await archives.readText(`${tar}/passwd`, MIB)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'link',
    })
  })

  it('marks encrypted entries and refuses to open them', async () => {
    const root = archiveRoot(
      put('locked.zip', zipOf([{ name: 'secret.txt', data: 'x', flags: 0x0801 }])),
    )
    expect(await archives.list(root)).toEqual([{ name: 'secret.txt', dir: false, encrypted: true }])
    expect(await archives.readText(`${root}/secret.txt`, MIB)).toEqual({
      ok: false,
      error: 'archive',
      reason: 'encrypted',
    })
  })

  it('does not open an archive inside an archive', async () => {
    const inner = zipOf([{ name: 'deep.txt', data: 'deep' }])
    const root = archiveRoot(put('outer.zip', zipOf([{ name: 'inner.zip', data: inner }])))
    expect(await archives.list(root)).toEqual([{ name: 'inner.zip', dir: false }])
    expect(await archives.list(archiveRoot(`${root}/inner.zip`))).toEqual([])
    const read = await archives.readBinary(`${root}/inner.zip`, MIB)
    expect(read.ok && read.data.length).toBe(inner.length)
  })

  it('stops a tar listing at the scan limit and refuses paths outside the roots', async () => {
    const items = Array.from({ length: 20 }, (_unused, i) => ({
      name: `f${i}.txt`,
      data: 'x'.repeat(4096),
    }))
    const small = archivesOver({ ...BROWSE_LIMITS, scanBytes: 8 * 4608 })
    const listed = await small.list(archiveRoot(put('many.tgz', tarOf(items))))
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.length).toBeLessThan(20)
    expect(await archives.list(archiveRoot('/etc/archive.zip'))).toEqual([])
    expect(await archives.list('archive:not-a-path')).toEqual([])
  })
})
