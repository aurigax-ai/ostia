import { mkdirSync, rmSync } from 'node:fs'
import { type FileHandle, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { openLines, sealLines } from './historyRecords'

export const RECORD_BYTES = 256 * 1024
const SEGMENT_BYTES = 16 * 1024 * 1024
const IDLE_FLUSH_MS = 1000
const MAX_BLOCKS = 20_000

interface Segment {
  path: string
  size: number
  handle: Promise<FileHandle>
}

interface StoredChunk {
  first: number
  count: number
  segment: Segment
  offset: number
  length: number
}

interface OpenChunk {
  first: number
  lines: string[]
  bytes: number
}

export interface HistoryChunk {
  first: number
  lines: string[]
}

export interface HistoryBlock {
  seq: number
  start: number
  end: number | null
  endCol: number
  exitCode: number | null
  command: string | null
}

export interface PaneHistoryDeps {
  dir: string
  key: Buffer
  limitBytes: () => number | null
  ensureSpace: (asking: PaneHistory) => Promise<boolean>
  onFailed: (reason: string) => void
  segmentBytes?: number
}

function failureReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string') return code
  return err instanceof Error ? err.message : 'write-failed'
}

function closeAndRemove(segments: readonly Segment[]): Promise<void> {
  return Promise.all(
    segments.map(async (segment) => {
      await segment.handle.then((h) => h.close()).catch(() => undefined)
      await unlink(segment.path).catch(() => undefined)
    }),
  ).then(() => undefined)
}

export class PaneHistory {
  first = 0
  end = 0
  bytes = 0
  seqOffset = 0
  failure: string | null = null
  private stored: StoredChunk[] = []
  private unwritten: OpenChunk[] = []
  private open: OpenChunk | null = null
  private segments: Segment[] = []
  private readonly blocks = new Map<number, HistoryBlock>()
  private writes: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private nextSegment = 0
  private disposed = false

  constructor(private readonly deps: PaneHistoryDeps) {}

  get live(): boolean {
    return !this.disposed && this.failure === null
  }

  append(lines: readonly string[]): void {
    if (!this.live || lines.length === 0) return
    let chunk = this.open
    if (!chunk) {
      chunk = { first: this.end, lines: [], bytes: 0 }
      this.open = chunk
      this.unwritten.push(chunk)
    }
    for (const line of lines) {
      chunk.lines.push(line)
      chunk.bytes += line.length + 1
    }
    this.end += lines.length
    if (chunk.bytes >= RECORD_BYTES) void this.flush()
    else this.armTimer()
  }

  flush(): Promise<void> {
    this.clearTimer()
    const chunk = this.open
    if (!chunk) return this.writes
    this.open = null
    const generation = this.generation
    this.writes = this.writes
      .then(() => this.write(chunk, generation))
      .catch((err: unknown) => this.fail(failureReason(err)))
    return this.writes
  }

  blockStarted(seq: number, start: number, command: string | null): void {
    if (!this.live) return
    this.blocks.set(seq, { seq, start, end: null, endCol: 0, exitCode: null, command })
    if (this.blocks.size > MAX_BLOCKS) {
      const oldest = this.blocks.keys().next().value
      if (oldest !== undefined) this.blocks.delete(oldest)
    }
  }

  blockEnded(
    seq: number,
    end: number,
    endCol: number,
    exitCode: number,
    command: string | null,
  ): void {
    const block = this.blocks.get(seq)
    if (!block) return
    block.end = end
    block.endCol = endCol
    block.exitCode = exitCode
    if (command) block.command = command
  }

  block(seq: number): HistoryBlock | undefined {
    const block = this.blocks.get(seq)
    return block && block.start >= this.first ? block : undefined
  }

  async *chunks(from: number, until: number): AsyncGenerator<HistoryChunk> {
    const generation = this.generation
    const overlaps = (first: number, count: number) => first + count > from && first < until
    const stored = this.stored.filter((c) => overlaps(c.first, c.count))
    const pending = this.unwritten
      .filter((c) => overlaps(c.first, c.lines.length))
      .map((c) => ({ first: c.first, lines: c.lines.slice() }))
    for (const chunk of stored) {
      if (generation !== this.generation) return
      yield { first: chunk.first, lines: await this.readChunk(chunk) }
    }
    for (const chunk of pending) {
      if (generation !== this.generation) return
      yield chunk
    }
  }

  async read(from: number, count: number): Promise<string[]> {
    const start = Math.max(from, this.first)
    const stop = Math.min(this.end, from + count)
    const out: string[] = []
    if (stop <= start) return out
    for await (const chunk of this.chunks(start, stop)) {
      const a = Math.max(start, chunk.first) - chunk.first
      const b = Math.min(stop, chunk.first + chunk.lines.length) - chunk.first
      for (let i = a; i < b; i++) out.push(chunk.lines[i])
    }
    return out
  }

  wipe(): void {
    this.clearTimer()
    this.generation++
    this.open = null
    this.unwritten = []
    this.stored = []
    this.blocks.clear()
    this.first = this.end
    this.bytes = 0
    const old = this.segments
    this.segments = []
    this.writes = this.writes.then(() => closeAndRemove(old))
  }

  get droppable(): boolean {
    return this.segments.length > 1
  }

  dropOldestSegment(): void {
    if (!this.droppable) return
    const [segment] = this.segments.splice(0, 1)
    this.stored = this.stored.filter((c) => c.segment !== segment)
    this.bytes -= segment.size
    this.first = this.stored[0]?.first ?? this.unwritten[0]?.first ?? this.end
    for (const [seq, block] of this.blocks) {
      if (block.start >= this.first) break
      this.blocks.delete(seq)
    }
    void closeAndRemove([segment])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.wipe()
    rmSync(this.deps.dir, { recursive: true, force: true })
  }

  private async write(chunk: OpenChunk, generation: number): Promise<void> {
    if (chunk.lines.length === 0) return
    const sealed = await sealLines(this.deps.key, chunk.lines)
    if (generation !== this.generation) return
    const segment = await this.segmentFor(sealed.length)
    const offset = segment.size
    segment.size += sealed.length
    const handle = await segment.handle
    await handle.write(sealed, 0, sealed.length, null)
    if (generation !== this.generation) return
    this.stored.push({
      first: chunk.first,
      count: chunk.lines.length,
      segment,
      offset,
      length: sealed.length,
    })
    this.unwritten = this.unwritten.filter((c) => c !== chunk)
    this.bytes += sealed.length
    this.enforceLimit()
  }

  private async segmentFor(length: number): Promise<Segment> {
    const last = this.segments.at(-1)
    if (last && last.size + length <= (this.deps.segmentBytes ?? SEGMENT_BYTES)) return last
    if (!(await this.deps.ensureSpace(this))) throw new Error('disk-full')
    if (this.disposed) throw new Error('disposed')
    mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 })
    const path = join(this.deps.dir, `${String(this.nextSegment++).padStart(6, '0')}.seg`)
    const segment: Segment = { path, size: 0, handle: open(path, 'ax', 0o600) }
    this.segments.push(segment)
    return segment
  }

  private enforceLimit(): void {
    const limit = this.deps.limitBytes()
    if (limit === null) return
    while (this.bytes > limit && this.droppable) this.dropOldestSegment()
  }

  private async readChunk(chunk: StoredChunk): Promise<string[]> {
    let handle: FileHandle | null = null
    try {
      handle = await open(chunk.segment.path, 'r')
      const buf = Buffer.alloc(chunk.length)
      await handle.read(buf, 0, chunk.length, chunk.offset)
      return await openLines(this.deps.key, buf)
    } catch {
      return new Array<string>(chunk.count).fill('')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private fail(reason: string): void {
    if (this.disposed || this.failure) return
    this.failure = reason
    this.deps.onFailed(reason)
    this.wipe()
  }

  private armTimer(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, IDLE_FLUSH_MS)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
