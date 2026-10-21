import { BrowseError, type BrowseFile, type BrowseProvider } from '@aurigax-ai/ostia-extension-sdk'
import { Parser, type ReadEntry } from 'tar'
import { type Decoders, InflateLimit, inflate, SNIFF_BYTES, sniffCompression } from './inflate'
import { shownLink, shownName } from './names'

const LINK_TYPES = new Set(['SymbolicLink', 'Link'])
const HEADER_BYTES = 512

type ScanEnd = 'complete' | 'stopped' | 'limit' | 'cancelled'
type Step = 'next' | 'stop' | 'read'

interface ScanOptions {
  scanBytes: number
  scanMs: number
  signal: AbortSignal
  visit: (entry: ReadEntry, index: number) => Step
  onRead: (entry: ReadEntry) => Promise<void>
}

async function scan(file: BrowseFile, decoders: Decoders, options: ScanOptions): Promise<ScanEnd> {
  const head = await file.readAt(0, Math.min(SNIFF_BYTES, file.size))
  const kind = sniffCompression(head)
  return new Promise((resolve) => {
    const input = file.stream()
    const inflated = kind ? inflate(input, kind, options.scanBytes, decoders) : null
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
      options.signal.removeEventListener('abort', cancel)
      input.destroy()
      for (const stage of inflated?.stages ?? []) stage.destroy()
      if (complete) resolve('complete')
      else if (options.signal.aborted) resolve('cancelled')
      else resolve(limited ? 'limit' : 'stopped')
    }
    const cancel = (): void => finish(false)
    const timer = setTimeout(() => finish(false), options.scanMs)
    options.signal.addEventListener('abort', cancel, { once: true })
    parser.on('entry', (entry: ReadEntry) => {
      scanned += HEADER_BYTES + entry.size
      if (scanned > options.scanBytes) {
        entry.resume()
        limited = true
        finish(false)
        return
      }
      const step = options.visit(entry, index++)
      if (step === 'read') {
        reading = true
        void options.onRead(entry).then(() => finish(true))
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
    for (const stage of inflated?.stages ?? []) {
      stage.on('error', (error) => {
        limited = error instanceof InflateLimit
        finish(false)
      })
    }
    ;(inflated?.output ?? input).pipe(parser)
  })
}

export function tarProvider(decoders: Decoders): BrowseProvider {
  return {
    async list(file, sink, { signal, limits }) {
      let chain: Promise<boolean> = Promise.resolve(true)
      let count = 0
      const end = await scan(file, decoders, {
        scanBytes: limits.scanBytes,
        scanMs: limits.scanMs,
        signal,
        visit: (entry) => {
          count += 1
          const added = {
            name: shownName(entry.path),
            dir: entry.type === 'Directory',
            size: entry.size,
            encrypted: false,
            link: LINK_TYPES.has(entry.type)
              ? shownLink(entry.linkpath ?? '', limits.linkTargetBytes)
              : null,
          }
          chain = chain.then((more) => (more ? sink.add(added) : false))
          return count > limits.entries ? 'stop' : 'next'
        },
        onRead: async () => {},
      })
      const more = await chain
      if (end === 'cancelled') throw new BrowseError('cancelled')
      if (end === 'complete' || count > 0) return { ok: true, complete: end === 'complete' && more }
      return { ok: false, error: end === 'limit' ? 'limit' : 'corrupt' }
    },

    async read(file, index, sink, { signal, limits, max }) {
      let result: Awaited<ReturnType<BrowseProvider['read']>> = { ok: false, error: 'gone' }
      const end = await scan(file, decoders, {
        scanBytes: limits.scanBytes,
        scanMs: limits.scanMs,
        signal,
        visit: (entry, at) => {
          if (at !== index) return 'next'
          if (LINK_TYPES.has(entry.type)) {
            result = { ok: false, error: 'link' }
            return 'stop'
          }
          if (entry.size > max) {
            result = { ok: false, error: 'too-large', size: entry.size }
            return 'stop'
          }
          return 'read'
        },
        onRead: async (entry) => {
          try {
            for await (const chunk of entry as AsyncIterable<Buffer>) {
              if (!(await sink.write(chunk))) {
                result = { ok: false, error: 'too-large' }
                return
              }
            }
            result = { ok: true }
          } catch {
            result = { ok: false, error: 'corrupt' }
          }
        },
      })
      if (end === 'cancelled') throw new BrowseError('cancelled')
      return end === 'limit' && !result.ok && result.error === 'gone'
        ? { ok: false, error: 'limit' }
        : result
    },
  }
}
