import { createReadStream } from 'node:fs'
import { type EntryRead, type RawEntry, openRegular } from '../../../shared/archives/archiveFile'
import { inflate, sniffCompression } from '../../../shared/archives/archiveInflate'
import { type TarInput, listTarEntries, readTarIndex } from '../../../shared/archives/tarScan'
import type { ArchiveLimits } from './archiveTree'

const READ_CHUNK = 16 * 1024

async function openTar(path: string, limits: ArchiveLimits): Promise<TarInput | null> {
  const fd = await openRegular(path)
  if (fd === null) return null
  const kind = await sniffCompression(fd)
  const input = createReadStream('', { fd, autoClose: true, highWaterMark: READ_CHUNK })
  const inflated = kind ? inflate(input, kind, limits.scanBytes) : null
  return { input, stages: inflated?.stages ?? [], output: inflated?.output ?? input }
}

export async function listTar(path: string, limits: ArchiveLimits): Promise<RawEntry[] | null> {
  const { entries, end } = await listTarEntries(() => openTar(path, limits), limits)
  return end === 'complete' || entries.length > 0 ? entries : null
}

export function readTarEntry(
  path: string,
  wanted: number,
  max: number,
  limits: ArchiveLimits,
): Promise<EntryRead> {
  return readTarIndex(() => openTar(path, limits), wanted, max, limits)
}
