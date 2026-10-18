import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type {
  ArchiveListResult,
  ArchiveReadRequest,
  ArchiveReaderLimits,
} from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { XzCompressor } from '@napi-rs/lzma'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TarItem, tarOf } from '../../../test/fixtures/archives/archives'
import { type Opener, listArchive, readArchive } from './archiveAnswers'
import { openXz } from './xzSource'

const MIB = 1024 * 1024
const LIMITS: ArchiveReaderLimits = {
  entries: 20_000,
  depth: 32,
  nameLength: 1_024,
  scanBytes: 1024 * MIB,
  scanMs: 20_000,
  linkTargetBytes: 1_024,
}
const SMALL = { ...LIMITS, scanBytes: MIB }
const BZIP2_HEAD = Buffer.from('BZh91AY&SY')

async function xz(bytes: Uint8Array): Promise<Buffer> {
  const compressor = new XzCompressor({ preset: 0 })
  return Buffer.concat([compressor.update(bytes), await compressor.finish()])
}

const FORMATS: [string, (bytes: Uint8Array) => Promise<Buffer>, Opener][] = [['tar.xz', xz, openXz]]

let dir: string
let reads: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'archives-ext-'))
  reads = join(dir, 'archive-reads')
  mkdirSync(reads)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tar(items: TarItem[]): Uint8Array {
  return tarOf(items, false)
}

function names(result: ArchiveListResult): string[] {
  if (!result.ok) throw new Error(`not listed: ${result.error}`)
  return result.entries.map((entry) => entry.name)
}

describe.each(FORMATS)('%s', (format, compress, opener) => {
  const live = new AbortController().signal

  async function put(bytes: Uint8Array, name = `a.${format}`): Promise<string> {
    const path = join(dir, name)
    writeFileSync(path, await compress(bytes))
    return path
  }

  function list(archive: string, limits = LIMITS, signal = live) {
    return listArchive({ op: 'list', reader: 'r', archive, limits }, opener, signal)
  }

  function read(archive: string, index: number, max = MIB, limits = LIMITS, out = 'e1') {
    const req: ArchiveReadRequest = {
      op: 'read',
      reader: 'r',
      archive,
      index,
      max,
      out: join(reads, out),
      limits,
    }
    return readArchive(req, opener, live, reads)
  }

  it('lists the same tree as a tar.gz and opens an entry into the file it was given', async () => {
    const path = await put(
      tar([
        { name: 'docs/readme.txt', data: 'hello' },
        { name: 'docs/deep/note.md', data: '# note' },
        { name: 'top.csv', data: 'a,b' },
      ]),
    )
    const listed = await list(path)
    expect(listed).toEqual({
      ok: true,
      complete: true,
      entries: [
        { name: 'docs/readme.txt', index: 0, dir: false, size: 5, encrypted: false, link: null },
        { name: 'docs/deep/note.md', index: 1, dir: false, size: 6, encrypted: false, link: null },
        { name: 'top.csv', index: 2, dir: false, size: 3, encrypted: false, link: null },
      ],
    })
    expect(await read(path, 1)).toEqual({ ok: true, size: 6 })
    expect(readFileSync(join(reads, 'e1'), 'utf8')).toBe('# note')
  })

  it('lists traversal and control names literally and writes nowhere but its file', async () => {
    const path = await put(
      tar([
        { name: '../up.txt', data: 'up inside' },
        { name: '/abs/file', data: 'abs inside' },
        { name: 'bell\u0007.txt', data: 'bell inside' },
      ]),
    )
    expect(names(await list(path))).toEqual(['../up.txt', '/abs/file', 'bell\u0007.txt'])
    expect(await read(path, 0, MIB, LIMITS, 'up')).toEqual({ ok: true, size: 9 })
    expect(await read(path, 1, MIB, LIMITS, 'abs')).toEqual({ ok: true, size: 10 })
    expect(readdirSync(dir).sort()).toEqual([`a.${format}`, 'archive-reads'])
    expect(readdirSync(reads).sort()).toEqual(['abs', 'up'])
  })

  it('refuses an entry by its declared size without unpacking it', async () => {
    const path = await put(
      tar([
        { name: 'big.bin', size: 64 * MIB },
        { name: 'after.txt', data: 'x' },
      ]),
    )
    const listed = await list(path)
    expect(listed.ok && listed.entries[0]).toMatchObject({ name: 'big.bin', size: 64 * MIB })
    expect(await read(path, 0)).toEqual({ ok: false, error: 'too-large', size: 64 * MIB })
    expect(readdirSync(reads)).toEqual([])
  })

  it('stops after a bounded decompressed output and says why', async () => {
    const path = await put(Buffer.alloc(4 * MIB, 0x41))
    expect(await list(path, SMALL)).toEqual({ ok: false, error: 'failed' })
    expect(await read(path, 0, MIB, SMALL)).toEqual({ ok: false, error: 'unzip-limit' })
  })

  it('stops a listing at the scan limit and says it is not complete', async () => {
    const path = await put(
      tar([
        { name: 'first.txt', data: 'x' },
        { name: 'zeros.bin', data: '\0'.repeat(2 * MIB) },
        { name: 'last.txt', data: 'y' },
      ]),
    )
    expect(await list(path, SMALL)).toMatchObject({
      ok: true,
      complete: false,
      entries: [{ name: 'first.txt' }],
    })
  })

  it('ends a listing at the end marker and stops decoding the zeros after it', async () => {
    const path = await put(
      Buffer.concat([tar([{ name: 'a.txt', data: 'first' }]), Buffer.alloc(16 * MIB)]),
    )
    let decoded = 0
    const counting: Opener = async (archive, limits) => {
      const source = await opener(archive, limits)
      source?.output.on('data', (chunk: Buffer) => {
        decoded += chunk.length
      })
      return source
    }
    const started = Date.now()
    const listed = await listArchive(
      { op: 'list', reader: 'r', archive: path, limits: LIMITS },
      counting,
      live,
    )
    expect(names(listed)).toEqual(['a.txt'])
    expect(listed.ok && listed.complete).toBe(true)
    expect(decoded).toBeLessThan(4 * MIB)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('lists a link with its target and refuses to open it', async () => {
    const path = await put(tar([{ name: 'passwd', type: '2', link: '../../etc/passwd' }]))
    const listed = await list(path)
    expect(listed.ok && listed.entries[0]).toMatchObject({
      name: 'passwd',
      link: '../../etc/passwd',
    })
    expect(await read(path, 0)).toEqual({ ok: false, error: 'link' })
  })

  it('fails without throwing on a cut file, the wrong format or a missing entry', async () => {
    const whole = await compress(tar([{ name: 'a.txt', data: 'x'.repeat(4096) }]))
    const cut = join(dir, `cut.${format}`)
    writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)))
    const plain = join(dir, `plain.${format}`)
    writeFileSync(plain, tar([{ name: 'a.txt', data: 'x' }]))
    for (const path of [cut, plain, join(dir, 'missing')]) {
      expect(await list(path), path).toEqual({ ok: false, error: 'failed' })
      expect((await read(path, 0)).ok, path).toBe(false)
    }
    const path = await put(tar([{ name: 'a.txt', data: 'x' }]))
    expect(await read(path, 5)).toEqual({ ok: false, error: 'gone' })
  })

  it('does not open a compressed stream inside the compressed stream', async () => {
    const inner = tar([{ name: 'a.txt', data: 'x' }])
    for (const nested of [gzipSync(inner), await xz(inner), Buffer.concat([BZIP2_HEAD, inner])]) {
      const path = await put(nested)
      expect(await list(path)).toEqual({ ok: false, error: 'failed' })
      expect(await read(path, 0)).toEqual({ ok: false, error: 'gone' })
    }
  })

  it('stops when the request is cancelled and answers the next one', async () => {
    const path = await put(tar([{ name: 'a.txt', data: 'x' }]))
    const abort = new AbortController()
    const pending = list(path, LIMITS, abort.signal)
    abort.abort()
    expect(await pending).toEqual({ ok: false, error: 'failed' })
    expect(names(await list(path))).toEqual(['a.txt'])
  })

  it('writes only a new regular file in its reads folder', async () => {
    const path = await put(tar([{ name: 'a.txt', data: 'x' }]))
    writeFileSync(join(reads, 'taken'), 'old')
    symlinkSync(join(dir, 'target'), join(reads, 'link'))
    expect(await read(path, 0, MIB, LIMITS, 'taken')).toEqual({ ok: false, error: 'failed' })
    expect(await read(path, 0, MIB, LIMITS, 'link')).toEqual({ ok: false, error: 'failed' })
    expect(readFileSync(join(reads, 'taken'), 'utf8')).toBe('old')
    expect(readdirSync(dir).sort()).toEqual([`a.${format}`, 'archive-reads'])
    const req: ArchiveReadRequest = {
      op: 'read',
      reader: 'r',
      archive: path,
      index: 0,
      max: MIB,
      out: join(dir, 'x'),
      limits: LIMITS,
    }
    expect(await readArchive(req, opener, live, reads)).toEqual({ ok: false, error: 'failed' })
    expect(await readArchive(req, opener, live, null)).toEqual({ ok: false, error: 'failed' })
  })
})
