import { gzipSync } from 'node:zlib'
import { Deflate, deflateSync, strToU8 } from 'fflate'

export interface ZipItem {
  name: string | Uint8Array
  data?: Uint8Array | string
  declaredSize?: number
  flags?: number
  mode?: number
  deflated?: Uint8Array
  size?: number
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)))
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of arrays) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function bytesOf(value: Uint8Array | string | undefined): Uint8Array {
  return typeof value === 'string' ? strToU8(value) : (value ?? new Uint8Array(0))
}

export function zipOf(items: ZipItem[]): Uint8Array {
  const locals: (Uint8Array | number[])[] = []
  const central: (Uint8Array | number[])[] = []
  let offset = 0
  for (const item of items) {
    const name = bytesOf(item.name)
    const plain = bytesOf(item.data)
    const data = item.deflated ?? deflateSync(plain)
    const size = item.declaredSize ?? item.size ?? plain.length
    const flags = item.flags ?? 0x0800
    const header = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(flags),
      ...u16(8),
      ...u32(0),
      ...u32(0),
      ...u32(data.length),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
    ]
    locals.push(header, name, data)
    central.push(
      [
        ...u32(0x02014b50),
        ...u16((3 << 8) | 20),
        ...u16(20),
        ...u16(flags),
        ...u16(8),
        ...u32(0),
        ...u32(0),
        ...u32(data.length),
        ...u32(size),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(((item.mode ?? 0o100644) << 16) >>> 0),
        ...u32(offset),
      ],
      name,
    )
    offset += header.length + name.length + data.length
  }
  const directory = concat(central)
  return concat([
    ...locals,
    directory,
    [
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(items.length),
      ...u16(items.length),
      ...u32(directory.length),
      ...u32(offset),
      ...u16(0),
    ],
  ])
}

export function zerosDeflated(bytes: number): Uint8Array {
  const chunks: Uint8Array[] = []
  const deflate = new Deflate({ level: 9 }, (chunk) => chunks.push(chunk))
  const block = new Uint8Array(1024 * 1024)
  for (let left = bytes; left > 0; left -= block.length) {
    deflate.push(left > block.length ? block : block.subarray(0, left), left <= block.length)
  }
  return concat(chunks)
}

export interface TarItem {
  name: string
  data?: string
  type?: '0' | '2' | '5'
  link?: string
  size?: number
}

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(strToU8(text).subarray(0, length))
  return out
}

function octal(value: number, length: number): Uint8Array {
  return field(`${value.toString(8).padStart(length - 1, '0')}\0`, length)
}

export function tarOf(items: TarItem[], gzip = true): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const item of items) {
    const data = strToU8(item.data ?? '')
    const header = new Uint8Array(512)
    header.set(field(item.name, 100), 0)
    header.set(octal(0o644, 8), 100)
    header.set(octal(0, 8), 108)
    header.set(octal(0, 8), 116)
    header.set(octal(item.size ?? (item.type === '0' || !item.type ? data.length : 0), 12), 124)
    header.set(octal(0, 12), 136)
    header.set(strToU8('        '), 148)
    header[156] = (item.type ?? '0').charCodeAt(0)
    header.set(field(item.link ?? '', 100), 157)
    header.set(strToU8('ustar\u000000'), 257)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.set(field(`${sum.toString(8).padStart(6, '0')}\0 `, 8), 148)
    blocks.push(header)
    if (data.length > 0 && (item.type ?? '0') === '0') {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
      padded.set(data)
      blocks.push(padded)
    }
  }
  blocks.push(new Uint8Array(1024))
  const tar = concat(blocks)
  return gzip ? new Uint8Array(gzipSync(tar)) : tar
}
