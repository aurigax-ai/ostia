export const ID3_HEADER_BYTES = 10
export const ID3_TAG_MAX_BYTES = 8 * 1024 * 1024

interface Id3Cover {
  mime: string
  data: Uint8Array<ArrayBuffer>
}

export interface Id3Tags {
  title?: string
  artist?: string
  album?: string
  cover?: Id3Cover
}

const COVER_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

function synchsafe(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] & 0x7f) << 21) |
    ((bytes[at + 1] & 0x7f) << 14) |
    ((bytes[at + 2] & 0x7f) << 7) |
    (bytes[at + 3] & 0x7f)
  )
}

function bigEndian(bytes: Uint8Array, at: number): number {
  return bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
}

function isId3(bytes: Uint8Array): boolean {
  return (
    bytes.length >= ID3_HEADER_BYTES &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33 &&
    (bytes[3] === 3 || bytes[3] === 4)
  )
}

export function id3TagLength(header: Uint8Array): number {
  if (!isId3(header)) return 0
  return ID3_HEADER_BYTES + synchsafe(header, 6)
}

function decode(bytes: Uint8Array, encoding: number): string {
  if (encoding === 1) {
    const bigEndianMark = bytes[0] === 0xfe && bytes[1] === 0xff
    const littleEndianMark = bytes[0] === 0xff && bytes[1] === 0xfe
    const label = bigEndianMark ? 'utf-16be' : 'utf-16le'
    return new TextDecoder(label).decode(bigEndianMark || littleEndianMark ? bytes.slice(2) : bytes)
  }
  const label = ['windows-1252', 'utf-16le', 'utf-16be', 'utf-8'][encoding] ?? 'utf-8'
  return new TextDecoder(label).decode(bytes)
}

function clean(text: string): string {
  return text.split('\0')[0].trim()
}

function terminatorAt(bytes: Uint8Array, from: number, encoding: number): number {
  const wide = encoding === 1 || encoding === 2
  for (let at = from; at < bytes.length; at += wide ? 2 : 1) {
    if (bytes[at] === 0 && (!wide || bytes[at + 1] === 0)) return at
  }
  return bytes.length
}

function pictureOf(body: Uint8Array): Id3Cover | null {
  const encoding = body[0]
  const mimeEnd = terminatorAt(body, 1, 0)
  const mime = new TextDecoder('windows-1252').decode(body.slice(1, mimeEnd)).toLowerCase()
  if (!COVER_MIMES.includes(mime)) return null
  const descriptionEnd = terminatorAt(body, mimeEnd + 2, encoding)
  const dataStart = descriptionEnd + (encoding === 1 || encoding === 2 ? 2 : 1)
  if (dataStart >= body.length) return null
  return { mime, data: body.slice(dataStart) }
}

export function parseId3(bytes: Uint8Array): Id3Tags {
  const tags: Id3Tags = {}
  if (!isId3(bytes)) return tags
  const version = bytes[3]
  const end = Math.min(bytes.length, ID3_HEADER_BYTES + synchsafe(bytes, 6))
  let at = ID3_HEADER_BYTES
  if (bytes[5] & 0x40) at += version === 4 ? synchsafe(bytes, at) : bigEndian(bytes, at) + 4
  while (at + ID3_HEADER_BYTES <= end && bytes[at] !== 0) {
    const id = new TextDecoder('latin1').decode(bytes.slice(at, at + 4))
    const size = version === 4 ? synchsafe(bytes, at + 4) : bigEndian(bytes, at + 4)
    const bodyStart = at + ID3_HEADER_BYTES
    if (size <= 0 || bodyStart + size > end) break
    const body = bytes.slice(bodyStart, bodyStart + size)
    if (id === 'TIT2') tags.title = clean(decode(body.slice(1), body[0]))
    else if (id === 'TPE1') tags.artist = clean(decode(body.slice(1), body[0]))
    else if (id === 'TALB') tags.album = clean(decode(body.slice(1), body[0]))
    else if (id === 'APIC' && !tags.cover) tags.cover = pictureOf(body) ?? undefined
    at = bodyStart + size
  }
  return tags
}
