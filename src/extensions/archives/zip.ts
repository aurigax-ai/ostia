import type { Readable } from 'node:stream'
import {
  BrowseError,
  type BrowseFile,
  type BrowseProvider,
  type EntrySink,
} from '@aurigax-ai/ostia-extension-sdk'
import {
  type Entry,
  fromRandomAccessReaderPromise,
  getFileNameLowLevel,
  RandomAccessReader,
  type ZipFile,
} from 'yauzl'
import { shownName } from './names'

const FILE_TYPE = 0o170000
const SYMLINK = 0o120000

class BlockReader extends RandomAccessReader {
  constructor(private readonly file: BrowseFile) {
    super()
  }

  override _readStreamForRange(start: number, end: number): Readable {
    return this.file.stream(start, end)
  }
}

async function openZip(file: BrowseFile): Promise<ZipFile> {
  try {
    return await fromRandomAccessReaderPromise(new BlockReader(file), file.size, {
      decodeStrings: false,
    })
  } catch {
    throw new BrowseError('corrupt')
  }
}

function nameOf(entry: Entry): string {
  return getFileNameLowLevel(
    entry.generalPurposeBitFlag,
    entry.fileName as unknown as Buffer,
    entry.extraFields,
    false,
  )
}

function isLink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & FILE_TYPE) === SYMLINK
}

function walk(
  zip: ZipFile,
  signal: AbortSignal,
  visit: (entry: Entry, index: number) => Promise<boolean>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    const fail = (error: unknown): void => {
      zip.close()
      reject(error)
    }
    zip.on('entry', (entry: Entry) => {
      if (signal.aborted) {
        fail(new BrowseError('cancelled'))
        return
      }
      visit(entry, index++).then((more) => {
        if (more) zip.readEntry()
        else {
          zip.close()
          resolve()
        }
      }, fail)
    })
    zip.on('end', () => resolve())
    zip.on('error', (error) => fail(new BrowseError('corrupt', error.message)))
    zip.readEntry()
  })
}

async function collectUpTo(stream: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += (chunk as Buffer).length
    if (total > max) {
      stream.destroy()
      return null
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function linkTarget(zip: ZipFile, entry: Entry, limit: number): Promise<string> {
  if (entry.isEncrypted() || entry.uncompressedSize > limit) return ''
  try {
    const stream = await zip.openReadStreamPromise(entry)
    const data = await collectUpTo(stream, limit)
    return data ? data.toString('utf8') : ''
  } catch {
    return ''
  }
}

async function listInto(
  file: BrowseFile,
  sink: EntrySink,
  signal: AbortSignal,
  linkLimit: number,
): Promise<boolean> {
  const zip = await openZip(file)
  let complete = true
  await walk(zip, signal, async (entry) => {
    const full = nameOf(entry)
    const name = shownName(full)
    const link = isLink(entry) ? await linkTarget(zip, entry, linkLimit) : null
    const more = await sink.add({
      name,
      dir: full.endsWith('/'),
      size: entry.uncompressedSize,
      encrypted: entry.isEncrypted(),
      link,
    })
    complete = more
    return more
  })
  return complete
}

export const zip: BrowseProvider = {
  async list(file, sink, { signal, limits }) {
    const complete = await listInto(file, sink, signal, limits.linkTargetBytes)
    return { ok: true, complete }
  },

  async read(file, index, sink, { signal, max }) {
    const opened = await openZip(file)
    let outcome: Awaited<ReturnType<BrowseProvider['read']>> = { ok: false, error: 'gone' }
    await walk(opened, signal, async (entry, at) => {
      if (at !== index) return true
      if (entry.isEncrypted()) outcome = { ok: false, error: 'encrypted' }
      else if (isLink(entry)) outcome = { ok: false, error: 'link' }
      else if (entry.uncompressedSize > max) {
        outcome = { ok: false, error: 'too-large', size: entry.uncompressedSize }
      } else outcome = await streamEntry(opened, entry, sink)
      return false
    })
    return outcome
  },
}

async function streamEntry(
  opened: ZipFile,
  entry: Entry,
  sink: Parameters<BrowseProvider['read']>[2],
): Promise<Awaited<ReturnType<BrowseProvider['read']>>> {
  try {
    const stream = await opened.openReadStreamPromise(entry)
    for await (const chunk of stream) {
      if (!(await sink.write(chunk as Buffer))) {
        stream.destroy()
        return { ok: false, error: 'too-large' }
      }
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof BrowseError) throw error
    const tooMany = error instanceof Error && /too many bytes/.test(error.message)
    return { ok: false, error: tooMany ? 'limit' : 'corrupt' }
  }
}
