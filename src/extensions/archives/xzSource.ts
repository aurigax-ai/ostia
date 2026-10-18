import { createReadStream } from 'node:fs'
import type { Duplex } from 'node:stream'
import { createDecompressStream } from '@napi-rs/lzma/xz'
import { openRegular } from '../../shared/archives/archiveFile'
import { budgeted } from '../../shared/archives/archiveInflate'
import type { Opener } from './archiveAnswers'
import { XzGuard } from './xzGuard'

const READ_CHUNK = 1024 * 1024

export function xzOpener(decoder: () => Duplex = createDecompressStream): Opener {
  return async (archive, limits) => {
    const fd = await openRegular(archive)
    if (fd === null) return null
    const input = createReadStream('', { fd, autoClose: true, highWaterMark: READ_CHUNK })
    const guard = new XzGuard()
    const { output, stages } = budgeted(input.pipe(guard), decoder(), limits.scanBytes)
    return { input, stages: [guard, ...stages], output }
  }
}

export const openXz = xzOpener()
