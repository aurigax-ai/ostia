export type Bzip2Problem = 'format' | 'crc' | 'truncated'

export class Bzip2Error extends Error {
  constructor(readonly problem: Bzip2Problem) {
    super(`bzip2: ${problem}`)
  }
}

class NeedInput extends Error {}

const BLOCK_MAGIC_HI = 0x314159
const BLOCK_MAGIC_LO = 0x265359
const END_MAGIC_HI = 0x177245
const END_MAGIC_LO = 0x385090
const MAX_GROUPS = 6
const MIN_GROUPS = 2
const GROUP_SIZE = 50
const MAX_CODE_LEN = 20
const MAX_SELECTORS = 18_002
const MAX_ALPHA = 258
const RUNA = 0
const RUNB = 1
const MAX_RUN = 2 * 1024 * 1024
export const MAX_BLOCK_BYTES = 2_700_000

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    table[i] = c >>> 0
  }
  return table
})()

class Bits {
  buf = new Uint8Array(0)
  len = 0
  pos = 0
  acc = 0
  count = 0

  push(chunk: Uint8Array): void {
    const live = this.len - this.pos
    if (this.pos > 0 && live + chunk.length <= this.buf.length) {
      this.buf.copyWithin(0, this.pos, this.len)
    } else if (live + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(2 * this.buf.length, live + chunk.length, 65_536))
      next.set(this.buf.subarray(this.pos, this.len))
      this.buf = next
    }
    this.len = live
    this.pos = 0
    this.buf.set(chunk, this.len)
    this.len += chunk.length
  }

  bytesLeft(): number {
    return this.len - this.pos + (this.count >> 3)
  }

  bits(n: number): number {
    while (this.count < n) {
      if (this.pos >= this.len) throw new NeedInput()
      this.acc = ((this.acc << 8) | this.buf[this.pos++]) >>> 0
      this.count += 8
    }
    this.count -= n
    return (this.acc >>> this.count) & ((1 << n) - 1)
  }

  bit(): number {
    return this.bits(1)
  }

  alignToByte(): void {
    this.count -= this.count & 7
    this.pos -= this.count >> 3
    this.count = 0
    this.acc = 0
  }

  mark(): [number, number, number] {
    return [this.pos, this.acc, this.count]
  }

  reset([pos, acc, count]: [number, number, number]): void {
    this.pos = pos
    this.acc = acc
    this.count = count
  }
}

interface Table {
  limit: Int32Array
  base: Int32Array
  perm: Int32Array
  minLen: number
  maxLen: number
}

function table(lengths: Uint8Array, alphaSize: number): Table {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    minLen = Math.min(minLen, lengths[i])
    maxLen = Math.max(maxLen, lengths[i])
  }
  const perm = new Int32Array(MAX_ALPHA)
  let pp = 0
  for (let len = minLen; len <= maxLen; len++) {
    for (let j = 0; j < alphaSize; j++) if (lengths[j] === len) perm[pp++] = j
  }
  const base = new Int32Array(MAX_CODE_LEN + 2)
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1]
  const limit = new Int32Array(MAX_CODE_LEN + 1).fill(-1)
  let vec = 0
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1] - base[len]
    limit[len] = vec - 1
    vec <<= 1
  }
  for (let len = minLen + 1; len <= maxLen; len++) {
    base[len] = ((limit[len - 1] + 1) << 1) - base[len]
  }
  return { limit, base, perm, minLen, maxLen }
}

function symbol(bits: Bits, t: Table, alphaSize: number): number {
  let len = t.minLen
  let code = bits.bits(len)
  while (code > t.limit[len]) {
    if (++len > t.maxLen) throw new Bzip2Error('format')
    code = (code << 1) | bits.bit()
  }
  const at = code - t.base[len]
  if (at < 0 || at >= alphaSize) throw new Bzip2Error('format')
  return t.perm[at]
}

class Block {
  private tPos: number
  private left: number
  private last = -1
  private same = 0
  private repeat = 0

  constructor(
    private readonly tt: Uint32Array,
    private readonly origPtr: number,
    private readonly size: number,
  ) {
    this.tPos = tt[origPtr] >>> 8
    this.left = size
  }

  restart(): void {
    this.tPos = this.tt[this.origPtr] >>> 8
    this.left = this.size
    this.last = -1
    this.same = 0
    this.repeat = 0
  }

  fill(out: Uint8Array, crc: { value: number } | null): number {
    let n = 0
    let c = crc?.value ?? 0
    const emit = (byte: number): void => {
      if (crc) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ byte) & 0xff]) >>> 0
      out[n++] = byte
    }
    while (n < out.length) {
      if (this.repeat > 0) {
        emit(this.last)
        this.repeat--
        continue
      }
      if (this.left === 0) break
      const entry = this.tt[this.tPos]
      this.tPos = entry >>> 8
      this.left--
      const byte = entry & 0xff
      if (this.same === 4) {
        this.repeat = byte
        this.same = 0
        continue
      }
      if (byte === this.last) this.same++
      else {
        this.last = byte
        this.same = 1
      }
      emit(byte)
    }
    if (crc) crc.value = c
    return n
  }
}

function decodeBlock(bits: Bits, blockMax: number): { block: Block; crc: number } {
  const crc = ((bits.bits(16) << 16) | bits.bits(16)) >>> 0
  if (bits.bit()) throw new Bzip2Error('format')
  const origPtr = bits.bits(24)
  const used = bits.bits(16)
  const seqToUnseq: number[] = []
  for (let i = 0; i < 16; i++) {
    if (!(used & (0x8000 >> i))) continue
    const bitsUsed = bits.bits(16)
    for (let j = 0; j < 16; j++) if (bitsUsed & (0x8000 >> j)) seqToUnseq.push(i * 16 + j)
  }
  if (seqToUnseq.length === 0) throw new Bzip2Error('format')
  const alphaSize = seqToUnseq.length + 2
  const nGroups = bits.bits(3)
  const nSelectors = bits.bits(15)
  if (nGroups < MIN_GROUPS || nGroups > MAX_GROUPS || nSelectors < 1) {
    throw new Bzip2Error('format')
  }
  const groupMtf = Array.from({ length: nGroups }, (_unused, i) => i)
  const selectors = new Uint8Array(Math.min(nSelectors, MAX_SELECTORS))
  for (let i = 0; i < nSelectors; i++) {
    let j = 0
    while (bits.bit()) if (++j >= nGroups) throw new Bzip2Error('format')
    const group = groupMtf[j]
    groupMtf.splice(j, 1)
    groupMtf.unshift(group)
    if (i < MAX_SELECTORS) selectors[i] = group
  }
  const tables: Table[] = []
  for (let g = 0; g < nGroups; g++) {
    const lengths = new Uint8Array(alphaSize)
    let len = bits.bits(5)
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (len < 1 || len > MAX_CODE_LEN) throw new Bzip2Error('format')
        if (!bits.bit()) break
        len += bits.bit() ? -1 : 1
      }
      lengths[s] = len
    }
    tables.push(table(lengths, alphaSize))
  }

  const eob = alphaSize - 1
  const mtf = new Uint8Array(256)
  for (let i = 0; i < 256; i++) mtf[i] = i
  const counts = new Uint32Array(256)
  const tt = new Uint32Array(blockMax)
  let size = 0
  let selector = 0
  let groupLeft = 0
  let current = tables[0]
  let run = 0
  let weight = 1
  const flush = (): void => {
    if (run === 0) return
    const byte = seqToUnseq[mtf[0]]
    if (size + run > blockMax) throw new Bzip2Error('format')
    counts[byte] += run
    tt.fill(byte, size, size + run)
    size += run
    run = 0
    weight = 1
  }
  for (;;) {
    if (groupLeft === 0) {
      if (selector >= selectors.length) throw new Bzip2Error('format')
      current = tables[selectors[selector++]]
      groupLeft = GROUP_SIZE
    }
    groupLeft--
    const sym = symbol(bits, current, alphaSize)
    if (sym === RUNA || sym === RUNB) {
      if (weight > MAX_RUN) throw new Bzip2Error('format')
      run += sym === RUNA ? weight : 2 * weight
      weight <<= 1
      continue
    }
    flush()
    if (sym === eob) break
    if (size >= blockMax) throw new Bzip2Error('format')
    const at = sym - 1
    const front = mtf[at]
    mtf.copyWithin(1, 0, at)
    mtf[0] = front
    const byte = seqToUnseq[front]
    counts[byte]++
    tt[size++] = byte
  }
  if (origPtr >= size) throw new Bzip2Error('format')
  const starts = new Uint32Array(256)
  for (let i = 0, sum = 0; i < 256; i++) {
    starts[i] = sum
    sum += counts[i]
  }
  for (let i = 0; i < size; i++) {
    const byte = tt[i] & 0xff
    tt[starts[byte]++] |= i << 8
  }
  return { block: new Block(tt, origPtr, size), crc }
}

type Step = 'stream' | 'block' | 'done'

export class Bzip2Decoder {
  private readonly input = new Bits()
  private ended = false
  private step: Step = 'stream'
  private blockMax = 0
  private block: Block | null = null
  private streams = 0
  private combined = 0

  push(chunk: Uint8Array): void {
    this.input.push(chunk)
  }

  end(): void {
    this.ended = true
  }

  read(out: Uint8Array): number | null {
    for (;;) {
      if (this.block) {
        const n = this.block.fill(out, null)
        if (n > 0) return n
        this.block = null
      }
      if (this.step === 'done') return null
      const mark = this.input.mark()
      try {
        if (!this.advance()) return 0
      } catch (err) {
        if (!(err instanceof NeedInput)) throw err
        if (this.ended) throw new Bzip2Error('truncated')
        this.input.reset(mark)
        return 0
      }
    }
  }

  private advance(): boolean {
    const bits = this.input
    if (this.step === 'stream') {
      if (this.streams > 0 && this.ended && bits.bytesLeft() === 0) {
        this.step = 'done'
        return true
      }
      if (bits.bytesLeft() < 4) {
        if (!this.ended) return false
        if (this.streams === 0) throw new Bzip2Error(bits.bytesLeft() ? 'format' : 'truncated')
        this.step = 'done'
        return true
      }
      const magic = bits.bits(24)
      const level = bits.bits(8) - 0x30
      if (magic !== 0x425a68 || level < 1 || level > 9) {
        if (this.streams === 0) throw new Bzip2Error('format')
        this.step = 'done'
        return true
      }
      this.blockMax = level * 100_000
      this.combined = 0
      this.streams++
      this.step = 'block'
      return true
    }
    if (!this.ended && bits.bytesLeft() < MAX_BLOCK_BYTES) return false
    const hi = bits.bits(24)
    const lo = bits.bits(24)
    if (hi === END_MAGIC_HI && lo === END_MAGIC_LO) {
      const stored = ((bits.bits(16) << 16) | bits.bits(16)) >>> 0
      if (stored !== this.combined) throw new Bzip2Error('crc')
      bits.alignToByte()
      this.step = 'stream'
      return true
    }
    if (hi !== BLOCK_MAGIC_HI || lo !== BLOCK_MAGIC_LO) throw new Bzip2Error('format')
    const { block, crc } = decodeBlock(bits, this.blockMax)
    const sum = { value: 0xffffffff }
    const scratch = new Uint8Array(65_536)
    while (block.fill(scratch, sum) > 0) {}
    if (~sum.value >>> 0 !== crc) throw new Bzip2Error('crc')
    block.restart()
    this.combined = (((this.combined << 1) | (this.combined >>> 31)) ^ crc) >>> 0
    this.block = block
    return true
  }
}
