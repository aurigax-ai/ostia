import { deflateRawSync } from 'node:zlib'

export interface ZipFileSpec {
  name: string
  data: Buffer | string
  mode?: number
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function makeZip(files: ZipFileSpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    const packed = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

export interface TarEntrySpec {
  name: string
  data?: Buffer | string
  mode?: number
  type?: '0' | '2' | '5'
  linkName?: string
}

function tarHeader(entry: TarEntrySpec, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(entry.name, 0, 100)
  header.write((entry.mode ?? 0o644).toString(8).padStart(7, '0'), 100, 8)
  header.write('0000000', 108, 8)
  header.write('0000000', 116, 8)
  header.write(size.toString(8).padStart(11, '0'), 124, 12)
  header.write('00000000000', 136, 12)
  header.write('        ', 148, 8)
  header.write(entry.type ?? '0', 156, 1)
  if (entry.linkName) header.write(entry.linkName, 157, 100)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

export function makeTar(entries: TarEntrySpec[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data =
      entry.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.data)
          ? entry.data
          : Buffer.from(entry.data)
    blocks.push(tarHeader(entry, data.length), data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
