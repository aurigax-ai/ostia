import { createReadStream } from 'node:fs'
import type { ArchiveReaderLimits } from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { createDecompressStream } from '@napi-rs/lzma/xz'
import { openRegular } from '../../shared/archives/archiveFile'
import { budgeted } from '../../shared/archives/archiveInflate'
import type { TarInput } from '../../shared/archives/tarScan'

const READ_CHUNK = 1024 * 1024

export async function openXz(
  archive: string,
  limits: ArchiveReaderLimits,
): Promise<TarInput | null> {
  const fd = await openRegular(archive)
  if (fd === null) return null
  const input = createReadStream('', { fd, autoClose: true, highWaterMark: READ_CHUNK })
  const { output, stages } = budgeted(input, createDecompressStream(), limits.scanBytes)
  return { input, stages, output }
}
