import { closeSync } from 'node:fs'
import { type Entry, type ZipFile, fromFdPromise, getFileNameLowLevel } from 'yauzl'
import { type EntryRead, collect, openRegular } from './archiveFile'
import type { ArchiveLimits, RawEntry } from './archiveTree'

const FILE_TYPE = 0o170000
const SYMLINK = 0o120000

async function openZip(path: string): Promise<ZipFile | null> {
  const fd = await openRegular(path)
  if (fd === null) return null
  try {
    return await fromFdPromise(fd, { decodeStrings: false, autoClose: true })
  } catch {
    closeSync(fd)
    return null
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
  visit: (entry: Entry, index: number) => Promise<boolean>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    zip.on('entry', (entry: Entry) => {
      visit(entry, index++).then(
        (more) => {
          if (more) zip.readEntry()
          else {
            zip.close()
            resolve()
          }
        },
        (error) => {
          zip.close()
          reject(error)
        },
      )
    })
    zip.on('end', () => resolve())
    zip.on('error', reject)
    zip.readEntry()
  })
}

async function linkTarget(zip: ZipFile, entry: Entry, limits: ArchiveLimits): Promise<string> {
  if (entry.isEncrypted() || entry.uncompressedSize > limits.linkTargetBytes) return ''
  const stream = await zip.openReadStreamPromise(entry).catch(() => null)
  if (!stream) return ''
  const read = await collect(stream, limits.linkTargetBytes)
  return read.ok ? read.data.toString('utf8') : ''
}

export async function listZip(path: string, limits: ArchiveLimits): Promise<RawEntry[] | null> {
  const zip = await openZip(path)
  if (!zip) return null
  const entries: RawEntry[] = []
  try {
    await walk(zip, async (entry, index) => {
      const name = nameOf(entry)
      const link = isLink(entry) ? await linkTarget(zip, entry, limits) : null
      entries.push({
        name,
        index,
        dir: name.endsWith('/'),
        size: entry.uncompressedSize,
        encrypted: entry.isEncrypted(),
        link,
      })
      return entries.length <= limits.entries
    })
  } catch {
    return null
  }
  return entries
}

export async function readZipEntry(path: string, wanted: number, max: number): Promise<EntryRead> {
  const zip = await openZip(path)
  if (!zip) return { ok: false, problem: 'gone' }
  let result: EntryRead = { ok: false, problem: 'gone' }
  try {
    await walk(zip, async (entry, index) => {
      if (index !== wanted) return true
      if (entry.isEncrypted()) result = { ok: false, problem: 'encrypted' }
      else if (isLink(entry)) result = { ok: false, problem: 'link' }
      else if (entry.uncompressedSize > max) {
        result = { ok: false, problem: 'too-large', size: entry.uncompressedSize }
      } else {
        const stream = await zip.openReadStreamPromise(entry)
        const read = await collect(stream, max)
        result = read.ok ? { ok: true, data: read.data } : { ok: false, problem: 'unzip-limit' }
      }
      return false
    })
  } catch {
    return { ok: false, problem: 'unreadable' }
  }
  return result
}
