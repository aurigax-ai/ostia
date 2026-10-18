import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ArchiveListRequest,
  ArchiveListResult,
  ArchiveReadRequest,
  ArchiveReadResult,
  ArchiveReaderLimits,
} from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import type { EntryRead } from '../../shared/archives/archiveFile'
import {
  type OpenTar,
  type TarInput,
  listTarEntries,
  readTarIndex,
} from '../../shared/archives/tarScan'

const OUT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

export type Opener = (archive: string, limits: ArchiveReaderLimits) => Promise<TarInput | null>

function stopAll(source: TarInput, error?: Error): void {
  source.input.destroy(error)
  for (const stage of source.stages) stage.destroy()
}

function cancellable(open: OpenTar, signal: AbortSignal): OpenTar {
  return async () => {
    if (signal.aborted) return null
    const source = await open()
    if (!source) return null
    if (signal.aborted) {
      stopAll(source)
      return null
    }
    const stop = (): void => stopAll(source, new Error('cancelled'))
    signal.addEventListener('abort', stop, { once: true })
    source.input.once('close', () => signal.removeEventListener('abort', stop))
    return source
  }
}

export async function listArchive(
  req: ArchiveListRequest,
  opener: Opener,
  signal: AbortSignal,
): Promise<ArchiveListResult> {
  const { entries, end } = await listTarEntries(
    cancellable(() => opener(req.archive, req.limits), signal),
    req.limits,
  )
  if (end !== 'complete' && entries.length === 0) return { ok: false, error: 'failed' }
  return {
    ok: true,
    entries,
    complete: end === 'complete' && entries.length <= req.limits.entries,
  }
}

function readFailure(read: Extract<EntryRead, { ok: false }>): ArchiveReadResult {
  if (read.problem === 'too-large') return { ok: false, error: 'too-large', size: read.size }
  if (read.problem === 'unreadable') return { ok: false, error: 'failed' }
  return { ok: false, error: read.problem }
}

async function writeOut(out: string, data: Buffer): Promise<boolean> {
  const file = await open(out, OUT_FLAGS, 0o600).catch(() => null)
  if (!file) return false
  try {
    await file.writeFile(data)
    return true
  } catch {
    return false
  } finally {
    await file.close().catch(() => {})
  }
}

export async function readArchive(
  req: ArchiveReadRequest,
  opener: Opener,
  signal: AbortSignal,
  readsDir: string | null,
): Promise<ArchiveReadResult> {
  if (!readsDir || dirname(req.out) !== readsDir) return { ok: false, error: 'failed' }
  const read = await readTarIndex(
    cancellable(() => opener(req.archive, req.limits), signal),
    req.index,
    req.max,
    req.limits,
  )
  if (!read.ok) return readFailure(read)
  if (signal.aborted || !(await writeOut(req.out, read.data))) return { ok: false, error: 'failed' }
  return { ok: true, size: read.data.length }
}
