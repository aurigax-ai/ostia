import type { Readable } from 'node:stream'
import { Parser, type ReadEntry } from 'tar'
import { type EntryRead, type RawEntry, collect } from './archiveFile'
import { InflateLimit } from './archiveInflate'

const LINK_TYPES = new Set(['SymbolicLink', 'Link'])
const HEADER_BYTES = 512

export type ScanEnd = 'complete' | 'stopped' | 'limit'

export interface TarScanLimits {
  readonly entries: number
  readonly scanBytes: number
  readonly scanMs: number
}

export interface TarInput {
  input: Readable
  stages: Readable[]
  output: Readable
}

export type OpenTar = () => Promise<TarInput | null>

function scanTar(
  open: OpenTar,
  limits: TarScanLimits,
  visit: (entry: ReadEntry, index: number) => 'next' | 'stop' | 'read',
  onRead: (entry: ReadEntry) => Promise<void>,
): Promise<ScanEnd> {
  return new Promise((resolve) => {
    void open().then(
      (source) => {
        if (source === null) {
          resolve('stopped')
          return
        }
        const { input, stages, output } = source
        const parser = new Parser({ gzip: false, zstd: false, brotli: false })
        let index = 0
        let scanned = 0
        let settled = false
        let reading = false
        let ended = false
        let limited = false
        const finish = (complete: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          input.destroy()
          for (const stage of stages) stage.destroy()
          if (complete) resolve('complete')
          else resolve(limited ? 'limit' : 'stopped')
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
        for (const stage of stages) {
          stage.on('error', (error) => {
            limited = error instanceof InflateLimit
            finish(false)
          })
        }
        output.pipe(parser)
      },
      () => resolve('stopped'),
    )
  })
}

export async function listTarEntries(
  open: OpenTar,
  limits: TarScanLimits,
): Promise<{ entries: RawEntry[]; end: ScanEnd }> {
  const entries: RawEntry[] = []
  const end = await scanTar(
    open,
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
  return { entries, end }
}

export async function readTarIndex(
  open: OpenTar,
  wanted: number,
  max: number,
  limits: TarScanLimits,
): Promise<EntryRead> {
  let result: EntryRead = { ok: false, problem: 'gone' }
  const end = await scanTar(
    open,
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
  return end === 'limit' && !result.ok && result.problem === 'gone'
    ? { ok: false, problem: 'unzip-limit' }
    : result
}
