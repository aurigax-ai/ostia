import { createReadStream } from 'node:fs'
import { Parser, type ReadEntry } from 'tar'
import { type EntryRead, collect, openRegular } from './archiveFile'
import type { ArchiveLimits, RawEntry } from './archiveTree'

const LINK_TYPES = new Set(['SymbolicLink', 'Link'])
const HEADER_BYTES = 512

function scan(
  path: string,
  limits: ArchiveLimits,
  visit: (entry: ReadEntry, index: number) => 'next' | 'stop' | 'read',
  onRead: (entry: ReadEntry) => Promise<void>,
): Promise<boolean> {
  return new Promise((resolve) => {
    void openRegular(path).then((fd) => {
      if (fd === null) {
        resolve(false)
        return
      }
      const input = createReadStream('', { fd, autoClose: true })
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
      input.on('error', () => finish(false))
      input.pipe(parser)
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
