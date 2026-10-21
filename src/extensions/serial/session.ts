import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs'

export const CR = 0x0d
export const LF = 0x0a
const MAX_RECORD = 4096
const MAX_UNECHOED = 4096
const LOOP_MIN_BYTES = 4

export const SECRET_SENT_RECORD = '[secret input not logged]'
export const SECRET_ECHO_RECORD = '[device output hidden during secret input]'

export interface LogFile {
  write: (text: string) => void
  close: () => void
}

const LOG_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK

export function prepareLogDir(dir: string, uid = process.getuid?.()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a folder`)
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} belongs to another user`)
  chmodSync(dir, 0o700)
}

export function openLogFile(path: string): LogFile {
  const fd = openSync(path, LOG_FLAGS, 0o600)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.nlink !== 1) throw new Error('has more than one link')
    fchmodSync(fd, 0o600)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  return {
    write: (text) => {
      writeSync(fd, text)
    },
    close: () => closeSync(fd),
  }
}

function escapeBytes(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\'
    else if (b === CR) out += '\\r'
    else if (b === LF) out += '\\n'
    else if (b === 0x09) out += '\\t'
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += `\\x${b.toString(16).padStart(2, '0')}`
  }
  return out
}

type Direction = 'sent' | 'received'

const MARK: Record<Direction, string> = { sent: '>', received: '<' }

interface Pending {
  bytes: number[]
  at: string
  timer: ReturnType<typeof setTimeout> | undefined
}

function endsRecord(direction: Direction, b: number): boolean {
  return b === LF || (direction === 'sent' && b === CR)
}

export class SessionLog {
  private readonly pending: Record<Direction, Pending> = {
    sent: { bytes: [], at: '', timer: undefined },
    received: { bytes: [], at: '', timer: undefined },
  }
  private broken = false

  constructor(
    private readonly file: LogFile,
    private readonly flushMs: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  note(text: string): void {
    this.flushAll()
    this.line(`${new Date().toISOString()} # ${text}`)
  }

  add(direction: Direction, bytes: Uint8Array): void {
    if (this.broken) return
    const pending = this.pending[direction]
    for (const b of bytes) {
      if (pending.bytes.length === 0) pending.at = new Date().toISOString()
      pending.bytes.push(b)
      if (endsRecord(direction, b) || pending.bytes.length >= MAX_RECORD) this.flush(direction)
    }
    clearTimeout(pending.timer)
    pending.timer =
      pending.bytes.length > 0 ? setTimeout(() => this.flush(direction), this.flushMs) : undefined
  }

  hidden(direction: Direction): void {
    this.flush(direction)
    const text = direction === 'sent' ? SECRET_SENT_RECORD : SECRET_ECHO_RECORD
    this.line(`${new Date().toISOString()} ${MARK[direction]} ${text}`)
  }

  flushAll(): void {
    this.flush('sent')
    this.flush('received')
  }

  close(text: string): void {
    this.note(text)
    this.broken = true
    try {
      this.file.close()
    } catch {}
  }

  private flush(direction: Direction): void {
    const pending = this.pending[direction]
    clearTimeout(pending.timer)
    pending.timer = undefined
    if (pending.bytes.length === 0) return
    const bytes = Uint8Array.from(pending.bytes)
    pending.bytes = []
    this.line(`${pending.at} ${MARK[direction]} ${escapeBytes(bytes)}`)
  }

  private line(text: string): void {
    if (this.broken) return
    try {
      this.file.write(`${text}\n`)
    } catch (err) {
      this.broken = true
      for (const pending of Object.values(this.pending)) clearTimeout(pending.timer)
      this.onError(err)
    }
  }
}

export class EchoLoop {
  private unechoed: number[] = []
  private matched = 0
  private enter = false
  private dead = false

  get alive(): boolean {
    return !this.dead
  }

  sent(bytes: Uint8Array): void {
    if (this.dead) return
    for (const b of bytes) this.unechoed.push(b)
    if (this.unechoed.length > MAX_UNECHOED) this.stop()
  }

  received(bytes: Uint8Array): void {
    if (this.dead) return
    for (const b of bytes) {
      if (this.unechoed.shift() !== b) {
        this.stop()
        return
      }
      this.matched++
      if (b === CR || b === LF) this.enter = true
    }
  }

  looped(): boolean {
    return !this.dead && this.unechoed.length === 0 && this.enter && this.matched >= LOOP_MIN_BYTES
  }

  stop(): void {
    this.dead = true
    this.unechoed = []
  }
}
