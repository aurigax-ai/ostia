import {
  AES_ID,
  type Folder,
  type ParsedHeader,
  refuse,
  SevenZipRefused,
  type StreamsInfo,
} from './sevenZipHeader'

const WINDOWS_UNIX_EXTENSION = 0x8000
const MODE_TYPE = 0o170000
const SYMLINK = 0o120000

export interface Placed {
  name: string
  dir: boolean
  size: number
  encrypted: boolean
  link: boolean
  folder: number
  offset: number
  crc: number | null
  streamed: boolean
}

function isLink(attributes: number | null): boolean {
  return (
    attributes !== null &&
    (attributes & WINDOWS_UNIX_EXTENSION) !== 0 &&
    ((attributes >>> 16) & MODE_TYPE) === SYMLINK
  )
}

function encryptedFolder(folder: Folder): boolean {
  return folder.coders.some((coder) => coder.id === AES_ID)
}

export function placeEntries(
  header: ParsedHeader,
  maxEntries: number,
): { entries: Placed[]; cut: boolean } {
  const streams: StreamsInfo | null = header.streams
  const placed: Placed[] = []
  let cut = header.fileCount > header.files.length
  let folder = 0
  let inFolder = 0
  let offset = 0
  let flat = 0
  const settle = (): void => {
    while (streams && folder < streams.folders.length && inFolder >= streams.streamCounts[folder]) {
      folder++
      inFolder = 0
      offset = 0
    }
  }
  settle()
  for (const file of header.files) {
    if (placed.length >= maxEntries) {
      cut = true
      break
    }
    if (file.anti) continue
    if (file.emptyStream) {
      placed.push({
        name: file.name,
        dir: !file.emptyFile,
        size: 0,
        encrypted: false,
        link: false,
        folder: -1,
        offset: 0,
        crc: null,
        streamed: false,
      })
      continue
    }
    if (!streams || folder >= streams.folders.length) {
      throw new SevenZipRefused('corrupt', '7z: more files than data streams')
    }
    const size = streams.streamSizes[flat]
    placed.push({
      name: file.name,
      dir: false,
      size,
      encrypted: encryptedFolder(streams.folders[folder]),
      link: isLink(file.attributes),
      folder,
      offset,
      crc: streams.streamCrcs[flat] ?? null,
      streamed: true,
    })
    flat++
    offset += size
    inFolder++
    settle()
  }
  return { entries: placed, cut }
}

export function requireSingleChain(streams: StreamsInfo): void {
  if (streams.packSizes.length !== streams.folders.length) {
    refuse('unsupported', '7z: a folder with several packed streams')
  }
}
