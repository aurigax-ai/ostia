import { crc32 } from 'node:zlib'
import {
  BrowseError,
  type BrowseFile,
  type BrowseProvider,
  type EntrySink,
} from '@aurigax-ai/ostia-extension-sdk'
import type { BrowseLimits } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { shownLink, shownName } from './names'
import {
  checkFolder,
  decodeFolder,
  type FolderRun,
  isEncrypted,
  type Native,
  nativeLzma,
  packRange,
} from './sevenZipCoders'
import { type Placed, placeEntries, requireSingleChain } from './sevenZipFiles'
import {
  crcOf,
  DECODED_HEADER_MAX,
  isEncodedHeader,
  PACKED_HEADER_MAX,
  type ParsedHeader,
  parseEncodedHeader,
  parseHeader,
  parseStartHeader,
  refuse,
  SevenZipRefused,
  SIGNATURE_HEADER_BYTES,
  type StreamsInfo,
  unpackSize,
} from './sevenZipHeader'

async function decodedHeader(
  file: BrowseFile,
  block: Uint8Array,
  limits: BrowseLimits,
  signal: AbortSignal,
  native: Native,
): Promise<Uint8Array> {
  const streams = parseEncodedHeader(block, {
    deadline: Date.now() + limits.scanMs,
    signal,
  })
  if (streams.folders.length !== 1)
    refuse('unsupported', '7z: an encoded header in several folders')
  requireSingleChain(streams)
  const [folder] = streams.folders
  if (isEncrypted(folder)) refuse('encrypted', '7z: the file names are encrypted')
  checkFolder(folder)
  const size = unpackSize(folder)
  if (size > DECODED_HEADER_MAX) refuse('limit', '7z: header over 64 MiB')
  const parts: Buffer[] = []
  const run: FolderRun = {
    file,
    streams,
    folder: 0,
    budget: DECODED_HEADER_MAX,
    scanMs: limits.scanMs,
    signal,
    native,
  }
  await decodeFolder(run, (chunk) => {
    parts.push(Buffer.from(chunk))
    return true
  })
  const out = Buffer.concat(parts)
  if (out.length !== size) refuse('corrupt', '7z: the header is shorter than it says')
  if (folder.crc !== null && crcOf(out) !== folder.crc) refuse('corrupt', '7z: header CRC')
  return out
}

async function readHeader(
  file: BrowseFile,
  limits: BrowseLimits,
  signal: AbortSignal,
  native: Native,
): Promise<ParsedHeader> {
  if (file.size < SIGNATURE_HEADER_BYTES) refuse('unsupported', 'not a 7z file')
  const start = parseStartHeader(await file.readAt(0, SIGNATURE_HEADER_BYTES))
  if (start.nextSize === 0) return { streams: null, files: [], fileCount: 0 }
  if (start.nextSize > PACKED_HEADER_MAX) refuse('limit', '7z: header over 16 MiB')
  const at = SIGNATURE_HEADER_BYTES + start.nextOffset
  if (at + start.nextSize > file.size) refuse('corrupt', '7z: the header is outside the file')
  const block = await file.readAt(at, start.nextSize)
  if (crcOf(block) !== start.nextCrc) refuse('corrupt', '7z: header CRC')
  const plain = isEncodedHeader(block)
    ? await decodedHeader(file, block, limits, signal, native)
    : block
  const header = parseHeader(plain, plain.length, {
    deadline: Date.now() + limits.scanMs,
    signal,
  })
  if (header.streams) {
    requireSingleChain(header.streams)
    header.streams.folders.forEach((folder, index) => {
      checkFolder(folder)
      const { start, end } = packRange(header.streams as StreamsInfo, index)
      if (end > file.size) refuse('corrupt', '7z: a packed stream outside the file')
      if (start < SIGNATURE_HEADER_BYTES) refuse('corrupt', '7z: a packed stream inside the header')
    })
  }
  return header
}

function fail(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new BrowseError('cancelled')
  if (error instanceof SevenZipRefused) throw new BrowseError(error.code, error.message)
  throw error
}

async function linkTargets(
  file: BrowseFile,
  header: ParsedHeader,
  entries: Placed[],
  limits: BrowseLimits,
  signal: AbortSignal,
  native: Native,
): Promise<Map<Placed, string>> {
  const targets = new Map<Placed, string>()
  const streams = header.streams
  if (!streams) return targets
  const byFolder = new Map<number, Placed[]>()
  for (const entry of entries) {
    if (!entry.link || entry.encrypted || entry.size > limits.linkTargetBytes) continue
    byFolder.set(entry.folder, [...(byFolder.get(entry.folder) ?? []), entry])
  }
  let left = limits.scanBytes
  for (const [folder, links] of byFolder) {
    const last = Math.max(...links.map((link) => link.offset + link.size))
    const pieces = new Map<Placed, Buffer[]>(links.map((link) => [link, []]))
    try {
      await decodeFolder(
        { file, streams, folder, budget: left, scanMs: limits.scanMs, signal, native },
        (chunk, at) => {
          left -= chunk.length
          for (const link of links) {
            const from = Math.max(link.offset, at)
            const to = Math.min(link.offset + link.size, at + chunk.length)
            if (to > from) pieces.get(link)?.push(Buffer.from(chunk.subarray(from - at, to - at)))
          }
          return at + chunk.length < last
        },
      )
    } catch (error) {
      if (signal.aborted) throw new BrowseError('cancelled')
      if (!(error instanceof SevenZipRefused)) throw error
      continue
    }
    for (const link of links) {
      targets.set(link, Buffer.concat(pieces.get(link) ?? []).toString('utf8'))
    }
  }
  return targets
}

async function emit(
  sink: EntrySink,
  entries: Placed[],
  targets: Map<Placed, string>,
  limits: BrowseLimits,
): Promise<boolean> {
  for (const entry of entries) {
    const more = await sink.add({
      name: shownName(entry.name),
      dir: entry.dir,
      size: entry.size,
      encrypted: entry.encrypted,
      link: entry.link ? shownLink(targets.get(entry) ?? '', limits.linkTargetBytes) : null,
    })
    if (!more) return false
  }
  return true
}

export function sevenZipProvider(native: Native = nativeLzma): BrowseProvider {
  return {
    async list(file, sink, { signal, limits }) {
      try {
        const header = await readHeader(file, limits, signal, native)
        const { entries, cut } = placeEntries(header, limits.entries + 1)
        const targets = await linkTargets(file, header, entries, limits, signal, native)
        const more = await emit(sink, entries, targets, limits)
        return { ok: true, complete: more && !cut }
      } catch (error) {
        return fail(error, signal)
      }
    },

    async read(file, index, sink, { signal, limits, max }) {
      try {
        const header = await readHeader(file, limits, signal, native)
        const entry = placeEntries(header, index + 1).entries[index]
        if (!entry || entry.dir) return { ok: false, error: 'gone' }
        if (entry.link) return { ok: false, error: 'link' }
        if (entry.encrypted) return { ok: false, error: 'encrypted' }
        if (entry.size > max) return { ok: false, error: 'too-large', size: entry.size }
        if (!entry.streamed || entry.size === 0) return { ok: true }
        const streams = header.streams
        if (!streams) return { ok: false, error: 'corrupt' }
        let crc = 0
        let seen = 0
        let refused = false
        await decodeFolder(
          {
            file,
            streams,
            folder: entry.folder,
            budget: limits.scanBytes,
            scanMs: limits.scanMs,
            signal,
            native,
          },
          async (chunk, at) => {
            const from = Math.max(entry.offset, at)
            const to = Math.min(entry.offset + entry.size, at + chunk.length)
            if (to > from) {
              const piece = chunk.subarray(from - at, to - at)
              crc = crc32(piece, crc)
              seen += piece.length
              if (!(await sink.write(piece))) {
                refused = true
                return false
              }
            }
            return at + chunk.length < entry.offset + entry.size
          },
        )
        if (refused) return { ok: false, error: 'too-large' }
        if (seen !== entry.size) return { ok: false, error: 'corrupt' }
        if (entry.crc !== null && crc >>> 0 !== entry.crc) return { ok: false, error: 'corrupt' }
        return { ok: true }
      } catch (error) {
        return fail(error, signal)
      }
    },
  }
}

export const sevenZip = sevenZipProvider()
