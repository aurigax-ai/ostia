import { Transform, type TransformCallback } from 'node:stream'
import { crc32 } from 'node:zlib'

export const XZ_DICT_MAX = 64 * 1024 * 1024

const STREAM_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]
const FOOTER_MAGIC = [0x59, 0x5a]
const STREAM_HEADER_BYTES = 12
const FOOTER_BYTES = 12
const LZMA2_FILTER = 0x21
const LZMA2_DICT_PROP_MAX = 40
const CHECK_BYTES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64]
const VARINT_BYTES_MAX = 9

class XzRefused extends Error {}

type Step =
  | {
      kind: 'take'
      bytes: number
      held: number[]
      sent: number
      defer: boolean
      then: (bytes: Uint8Array) => void
    }
  | { kind: 'skip'; bytes: number; then: () => void }

function refuse(reason: string): never {
  throw new XzRefused(`xz: ${reason}`)
}

function same(bytes: Uint8Array, at: number, magic: number[]): boolean {
  return magic.every((byte, i) => bytes[at + i] === byte)
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

export function lzma2DictSize(prop: number): number {
  if (prop > LZMA2_DICT_PROP_MAX) refuse('bad LZMA2 dictionary size')
  if (prop === LZMA2_DICT_PROP_MAX) return 0xffffffff
  return (2 | (prop & 1)) * 2 ** ((prop >> 1) + 11)
}

function varint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0
  for (let i = 0; i < VARINT_BYTES_MAX; i++) {
    const byte = bytes[at + i]
    if (byte === undefined) refuse('cut field')
    value += (byte & 0x7f) * 2 ** (7 * i)
    if (!(byte & 0x80)) {
      if (i > 0 && byte === 0) refuse('bad number')
      return { value, next: at + i + 1 }
    }
  }
  return refuse('bad number')
}

export class XzGuard extends Transform {
  private step: Step
  private check = 0
  private flags = 0
  private blocks = 0
  private block = 0
  private records = 0
  private index = 0
  private padding = 0
  private varintBytes: number[] = []
  private between = false
  private withheld: Uint8Array[] = []

  constructor() {
    super()
    this.step = this.streamHeader([])
  }

  private hold(bytes: number, then: (bytes: Uint8Array) => void, held: number[] = []): Step {
    return { kind: 'take', bytes, held, sent: held.length, defer: false, then }
  }

  private withhold(bytes: number, then: (bytes: Uint8Array) => void, held: number[] = []): Step {
    return { kind: 'take', bytes, held, sent: held.length, defer: true, then }
  }

  private send(bytes: Uint8Array): void {
    for (const part of this.withheld.splice(0)) this.push(part)
    if (bytes.length > 0) this.push(bytes)
  }

  private pass(bytes: number, then: () => void): Step {
    return bytes > 0 ? { kind: 'skip', bytes, then } : this.after(then)
  }

  private after(then: () => void): Step {
    return { kind: 'skip', bytes: 0, then }
  }

  private streamHeader(held: number[]): Step {
    this.between = false
    return this.withhold(
      STREAM_HEADER_BYTES,
      (h) => {
        if (!same(h, 0, STREAM_MAGIC)) refuse('not an xz stream')
        if (h[6] !== 0 || h[7] > 0x0f) refuse('unsupported stream flags')
        if (crc32(h.subarray(6, 8)) !== u32(h, 8)) refuse('stream header CRC')
        this.flags = h[7]
        this.check = CHECK_BYTES[h[7]]
        this.blocks = 0
        this.step = this.blockOrIndex()
      },
      held,
    )
  }

  private blockOrIndex(): Step {
    return this.withhold(1, ([first]) => {
      if (first === 0) {
        this.index = 1
        this.step = this.indexCount()
        return
      }
      const size = (first + 1) * 4
      this.step = this.hold(size, (h) => this.blockHeader(h), [first])
    })
  }

  private blockHeader(h: Uint8Array): void {
    const size = h.length
    if (crc32(h.subarray(0, size - 4)) !== u32(h, size - 4)) refuse('block header CRC')
    const flags = h[1]
    if (flags & 0x3c) refuse('reserved block flags')
    if ((flags & 0x03) !== 0) refuse('only one LZMA2 filter is read')
    let at = 2
    if (flags & 0x40) at = varint(h, at).next
    if (flags & 0x80) at = varint(h, at).next
    const filter = varint(h, at)
    if (filter.value !== LZMA2_FILTER) refuse('only one LZMA2 filter is read')
    const props = varint(h, filter.next)
    if (props.value !== 1 || props.next >= size - 4) refuse('bad LZMA2 properties')
    if (lzma2DictSize(h[props.next]) > XZ_DICT_MAX) refuse('LZMA2 dictionary over 64 MiB')
    for (let i = props.next + 1; i < size - 4; i++) if (h[i] !== 0) refuse('block header padding')
    this.blocks++
    this.block = size
    this.step = this.chunk()
  }

  private chunk(): Step {
    return this.hold(1, ([control]) => {
      this.block += 1
      if (control === 0x00) {
        const pad = (4 - (this.block % 4)) % 4
        this.step = this.hold(pad, (zeros) => {
          if (zeros.some((byte) => byte !== 0)) refuse('block padding')
          this.step = this.pass(this.check, () => {
            this.step = this.blockOrIndex()
          })
        })
        return
      }
      if (control === 0x01 || control === 0x02) {
        this.step = this.hold(2, (size) => {
          const bytes = ((size[0] << 8) | size[1]) + 1
          this.block += 2 + bytes
          this.step = this.pass(bytes, () => {
            this.step = this.chunk()
          })
        })
        return
      }
      if (control < 0x80) refuse('bad LZMA2 chunk')
      this.step = this.hold(control >= 0xc0 ? 5 : 4, (fields) => {
        const packed = ((fields[2] << 8) | fields[3]) + 1
        this.block += fields.length + packed
        this.step = this.pass(packed, () => {
          this.step = this.chunk()
        })
      })
    })
  }

  private indexCount(): Step {
    return this.indexVarint((count) => {
      if (count !== this.blocks) refuse('index does not match the blocks')
      this.records = count * 2
      this.step = this.indexRecord()
    })
  }

  private indexRecord(): Step {
    if (this.records === 0) {
      const pad = (4 - (this.index % 4)) % 4
      return this.hold(pad + 4, (tail) => {
        if (tail.subarray(0, pad).some((byte) => byte !== 0)) refuse('index padding')
        this.step = this.hold(FOOTER_BYTES, (footer) => {
          if (!same(footer, 10, FOOTER_MAGIC)) refuse('stream footer')
          if (footer[8] !== 0 || footer[9] !== this.flags) refuse('stream footer flags')
          if (crc32(footer.subarray(4, 10)) !== u32(footer, 0)) refuse('stream footer CRC')
          this.padding = 0
          this.between = true
          this.step = this.streamPadding()
        })
      })
    }
    return this.indexVarint(() => {
      this.records--
      this.step = this.indexRecord()
    })
  }

  private indexVarint(then: (value: number) => void): Step {
    return this.hold(1, ([byte]) => {
      this.index++
      this.varintBytes.push(byte)
      if (byte & 0x80) {
        if (this.varintBytes.length >= VARINT_BYTES_MAX) refuse('bad number')
        this.step = this.indexVarint(then)
        return
      }
      const { value } = varint(Uint8Array.from(this.varintBytes), 0)
      this.varintBytes = []
      then(value)
    })
  }

  private streamPadding(): Step {
    return this.withhold(1, ([byte]) => {
      if (byte === 0) {
        this.padding++
        this.step = this.streamPadding()
        return
      }
      if (this.padding % 4 !== 0) refuse('stream padding')
      this.step = this.streamHeader([byte])
    })
  }

  private feed(chunk: Uint8Array): void {
    let at = 0
    for (;;) {
      const step = this.step
      if (step.kind === 'skip') {
        const bytes = Math.min(step.bytes, chunk.length - at)
        if (bytes > 0) this.send(chunk.subarray(at, at + bytes))
        at += bytes
        step.bytes -= bytes
        if (step.bytes > 0) return
        step.then()
        continue
      }
      while (step.held.length < step.bytes && at < chunk.length) step.held.push(chunk[at++])
      if (step.held.length < step.bytes) return
      const bytes = Uint8Array.from(step.held)
      step.then(bytes)
      const fresh = bytes.subarray(step.sent)
      if (step.defer) this.withheld.push(fresh)
      else this.send(fresh)
      if (at >= chunk.length && this.step.kind === 'take' && this.step.bytes > 0) return
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.feed(chunk)
      done()
    } catch (err) {
      done(err as Error)
    }
  }

  override _flush(done: TransformCallback): void {
    const step = this.step
    const idle = step.kind === 'take' && step.held.length === 0
    if (!this.between || !idle || this.padding % 4 !== 0) {
      done(new XzRefused('xz: cut stream'))
      return
    }
    this.send(new Uint8Array(0))
    done()
  }
}
