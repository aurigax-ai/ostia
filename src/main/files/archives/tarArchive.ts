import { createReadStream, read } from 'node:fs'
import { Transform } from 'node:stream'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { Parser, type ReadEntry } from 'tar'
import { type EntryRead, collect, openRegular } from './archiveFile'
import type { ArchiveLimits, RawEntry } from './archiveTree'

const LINK_TYPES = new Set(['SymbolicLink', 'Link'])
const HEADER_BYTES = 512
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const INFLATERS = { gzip: createGunzip, zstd: createZstdDecompress }

function compression(head: Buffer): keyof typeof INFLATERS | null {
  if (head.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)) return 'gzip'
  if (head.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) return 'zstd'
  return null
}

function headOf(fd: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const head = Buffer.alloc(ZSTD_MAGIC.length)
    read(fd, head, 0, head.length, 0, (error, bytes) => {
      resolve(error ? Buffer.alloc(0) : head.subarray(0, bytes))
    })
  })
}

function plainTar(maxBytes: number): Transform {
  let total = 0
  let head = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length
      if (head.length < ZSTD_MAGIC.length) {
        head = Buffer.concat([head, chunk.subarray(0, ZSTD_MAGIC.length)])
      }
      if (total > maxBytes) done(new Error('archive too large'))
      else if (compression(head)) done(new Error('archive compressed twice'))
      else done(null, chunk)
    },
  })
}

function scan(
  path: string,
  limits: ArchiveLimits,
  visit: (entry: ReadEntry, index: number) => 'next' | 'stop' | 'read',
  onRead: (entry: ReadEntry) => Promise<void>,
): Promise<boolean> {
  return new Promise((resolve) => {
    void openRegular(path).then(async (fd) => {
      if (fd === null) {
        resolve(false)
        return
      }
      const format = compression(await headOf(fd))
      const input = createReadStream('', { fd, autoClose: true })
      const inflater = format ? INFLATERS[format]() : null
      const plain = plainTar(limits.scanBytes)
      const parser = new Parser()
      let index = 0
      let scanned = 0
      let settled = false
      let reading = false
      let ended = false
      const finish = (complete: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.destroy()
        inflater?.destroy()
        plain.destroy()
        resolve(complete)
      }
      const timer = setTimeout(() => finish(false), limits.scanMs)
      parser.on('entry', (entry: ReadEntry) => {
        scanned += HEADER_BYTES + entry.size
        if (scanned > limits.scanBytes) {
          entry.resume()
          finish(false)
          return
        }
        const step = visit(entry, index++)
        if (step === 'read') {
          reading = true
          void onRead(entry).then(() => finish(true))
          return
        }
        entry.resume()
        if (step === 'stop') finish(true)
      })
      parser.on('eof', () => {
        ended = true
        if (!reading) finish(true)
        parser.abort(new Error('end of archive'))
      })
      parser.on('end', () => finish(true))
      parser.on('error', () => {
        if (!ended) finish(false)
      })
      for (const stream of [input, inflater, plain]) stream?.on('error', () => finish(false))
      const source = inflater ? input.pipe(inflater) : input
      source.pipe(plain).pipe(parser)
    })
  })
}

export async function listTar(path: string, limits: ArchiveLimits): Promise<RawEntry[] | null> {
  const entries: RawEntry[] = []
  const complete = await scan(
    path,
    limits,
    (entry, index) => {
      entries.push({
        name: entry.path,
        index,
        dir: entry.type === 'Directory',
        size: entry.size,
        encrypted: false,
        link: LINK_TYPES.has(entry.type) ? (entry.linkpath ?? '') : null,
      })
      return entries.length > limits.entries ? 'stop' : 'next'
    },
    async () => {},
  )
  return complete || entries.length > 0 ? entries : null
}

export async function readTarEntry(
  path: string,
  wanted: number,
  max: number,
  limits: ArchiveLimits,
): Promise<EntryRead> {
  let result: EntryRead = { ok: false, problem: 'gone' }
  await scan(
    path,
    limits,
    (entry, index) => {
      if (index !== wanted) return 'next'
      if (LINK_TYPES.has(entry.type)) {
        result = { ok: false, problem: 'link' }
        return 'stop'
      }
      if (entry.size > max) {
        result = { ok: false, problem: 'too-large', size: entry.size }
        return 'stop'
      }
      return 'read'
    },
    async (entry) => {
      const read = await collect(entry as unknown as Parameters<typeof collect>[0], max)
      result = read.ok ? { ok: true, data: read.data } : { ok: false, problem: 'unreadable' }
    },
  )
  return result
}
