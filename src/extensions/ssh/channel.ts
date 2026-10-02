import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { HELPER_PROTOCOL, STATUS_PREFIX } from './helper'

export const HELLO_TIMEOUT_MS = 20_000
export const REQUEST_TIMEOUT_MS = 30_000
export const NOISE_MAX_BYTES = 64 * 1024
export const HEADER_MAX_BYTES = 512
export const ERROR_LINE_MAX = 240
export const BUFFER_MAX_BYTES = 16 * 1024 * 1024

export const HELPER_ERRORS = [
  'not-found',
  'outside',
  'not-file',
  'not-dir',
  'too-large',
  'changed',
  'symlink',
  'denied',
  'bad-request',
  'failed',
] as const

export type HelperError = (typeof HELPER_ERRORS)[number]

export type ChannelError =
  | HelperError
  | 'ssh-missing'
  | 'connect-failed'
  | 'timeout'
  | 'missing'
  | 'corrupt'
  | 'incompatible'
  | 'needs-tool'
  | 'install-failed'
  | 'remove-failed'
  | 'protocol'
  | 'closed'

export class HelperFailure extends Error {
  constructor(
    readonly code: ChannelError,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

export type SpawnSsh = (argv: string[]) => ChildProcessWithoutNullStreams

export const spawnSsh: SpawnSsh = (argv) =>
  spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })

export class ByteQueue {
  private buffer: Buffer = Buffer.alloc(0)
  private ended = false
  private wake: (() => void) | null = null

  constructor(
    private readonly maxBytes = BUFFER_MAX_BYTES,
    private readonly onOverflow: () => void = () => {},
  ) {}

  push(chunk: Buffer): void {
    if (this.ended) return
    if (this.buffer.length + chunk.length > this.maxBytes) {
      this.buffer = Buffer.alloc(0)
      this.end()
      this.onOverflow()
      return
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  private more(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null
        resolve()
      }
    })
  }

  async line(maxBytes: number): Promise<string | null> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline >= 0 && newline <= maxBytes) {
        const text = this.buffer.subarray(0, newline).toString('utf8')
        this.buffer = this.buffer.subarray(newline + 1)
        return text
      }
      if (newline > maxBytes || this.buffer.length > maxBytes) {
        throw new HelperFailure('protocol', 'line too long')
      }
      if (this.ended) return null
      await this.more()
    }
  }

  async bytes(count: number): Promise<Buffer | null> {
    while (this.buffer.length < count) {
      if (this.ended) return null
      await this.more()
    }
    const taken = Buffer.from(this.buffer.subarray(0, count))
    this.buffer = this.buffer.subarray(count)
    return taken
  }
}

export function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  return line ? line.slice(0, ERROR_LINE_MAX) : undefined
}

interface Running {
  child: ChildProcessWithoutNullStreams
  out: ByteQueue
  stderr: () => string
  missing: () => boolean
  exited: Promise<void>
}

function start(argv: string[], spawnFn: SpawnSsh): Running {
  const child = spawnFn(argv)
  const out = new ByteQueue(BUFFER_MAX_BYTES, () => child.kill('SIGTERM'))
  let stderr = ''
  let missing = false
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < NOISE_MAX_BYTES) stderr += chunk.toString('utf8')
  })
  child.stdin.on('error', () => {})
  const exited = new Promise<void>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      missing = err.code === 'ENOENT'
      if (!stderr) stderr = err.message
      out.end()
      resolve()
    })
    child.on('close', () => {
      out.end()
      resolve()
    })
  })
  return { child, out, stderr: () => stderr, missing: () => missing, exited }
}

function connectFailure(running: Running): HelperFailure {
  if (running.missing()) return new HelperFailure('ssh-missing')
  return new HelperFailure('connect-failed', firstLine(running.stderr()))
}

async function status(running: Running): Promise<string[]> {
  let noise = 0
  for (;;) {
    const line = await running.out.line(NOISE_MAX_BYTES)
    if (line === null) {
      await running.exited
      throw connectFailure(running)
    }
    if (line.startsWith(STATUS_PREFIX)) {
      return line.slice(STATUS_PREFIX.length).trim().split(' ').filter(Boolean)
    }
    noise += line.length + 1
    if (noise > NOISE_MAX_BYTES) throw new HelperFailure('protocol', 'no status line')
  }
}

function deadline<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new HelperFailure('timeout'))
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export interface ChannelOptions {
  spawn?: SpawnSsh
  helloTimeoutMs?: number
  requestTimeoutMs?: number
}

export async function runStatus(
  argv: string[],
  input: Buffer | null,
  opts: ChannelOptions = {},
): Promise<string[]> {
  const running = start(argv, opts.spawn ?? spawnSsh)
  running.child.stdin.end(input ?? undefined)
  try {
    return await deadline(status(running), opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, () =>
      running.child.kill('SIGTERM'),
    )
  } finally {
    running.child.kill('SIGTERM')
  }
}

export interface HelperReply {
  meta: string
  payload: Buffer
}

export interface HelperRequest {
  op: 'list' | 'stat' | 'read' | 'write'
  number: number
  version?: string
  root: string
  path: string
  payload?: Buffer
  maxReply: number
}

const HEADER_PATTERN = /^(\d{1,9}) (ok|err) (\d{1,9}) ([\x21-\x7e]{1,128})$/
const REQUEST_VERSION_PATTERN = /^[\x21-\x7e]{1,80}$/

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function requestLine(id: number, req: HelperRequest): string {
  const version = req.version ?? '-'
  const plain = [req.root, req.path].every((p) => p.startsWith('/') && !hasControlChar(p))
  if (!plain || !REQUEST_VERSION_PATTERN.test(version) || !Number.isSafeInteger(req.number)) {
    throw new HelperFailure('bad-request')
  }
  if (req.number < 0 || req.number > 999_999_999) throw new HelperFailure('bad-request')
  return `${id} ${req.op} ${req.number} ${version} ${req.root}\t${req.path}\n`
}

export function parseHeader(
  line: string,
  id: number,
  maxReply: number,
): { ok: boolean; length: number; meta: string } {
  const match = HEADER_PATTERN.exec(line)
  if (!match) throw new HelperFailure('protocol', 'malformed reply')
  if (Number(match[1]) !== id) throw new HelperFailure('protocol', 'reply out of order')
  const length = Number(match[3])
  const ok = match[2] === 'ok'
  if (length > maxReply || (!ok && length !== 0)) {
    throw new HelperFailure('protocol', 'reply too large')
  }
  return { ok, length, meta: match[4] }
}

function helperError(meta: string): HelperError {
  return (HELPER_ERRORS as readonly string[]).includes(meta) ? (meta as HelperError) : 'failed'
}

export class HelperChannel {
  private nextId = 1
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly closeListeners = new Set<() => void>()

  private constructor(
    private readonly running: Running,
    private readonly requestTimeoutMs: number,
  ) {
    void running.exited.then(() => this.markClosed())
  }

  static async open(argv: string[], opts: ChannelOptions = {}): Promise<HelperChannel> {
    const running = start(argv, opts.spawn ?? spawnSsh)
    const kill = (): void => {
      running.child.kill('SIGTERM')
    }
    let words: string[]
    try {
      words = await deadline(status(running), opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS, kill)
    } catch (err) {
      kill()
      throw err
    }
    if (words[0] === 'ready' && words[1] === String(HELPER_PROTOCOL)) {
      return new HelperChannel(running, opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
    }
    kill()
    if (words[0] === 'ready') throw new HelperFailure('incompatible', words[1])
    if (words[0] === 'missing' || words[0] === 'corrupt') throw new HelperFailure(words[0])
    throw new HelperFailure('protocol', 'unexpected status')
  }

  get isClosed(): boolean {
    return this.closed
  }

  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.closeListeners.add(listener)
  }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }

  close(): void {
    this.markClosed()
    this.running.child.stdin.end()
    this.running.child.kill('SIGTERM')
  }

  request(req: HelperRequest): Promise<HelperReply> {
    const run = this.tail.then(() => this.exchange(req))
    this.tail = run.catch(() => {})
    return run
  }

  private async exchange(req: HelperRequest): Promise<HelperReply> {
    if (this.closed) throw new HelperFailure('closed')
    const id = this.nextId
    const line = requestLine(id, req)
    if ((req.payload?.length ?? 0) !== (req.op === 'write' ? req.number : 0)) {
      throw new HelperFailure('bad-request')
    }
    this.nextId += 1
    const stdin = this.running.child.stdin
    stdin.write(line)
    if (req.payload && req.payload.length > 0) stdin.write(req.payload)
    try {
      return await deadline(this.reply(id, req.maxReply), this.requestTimeoutMs, () => {})
    } catch (err) {
      if (err instanceof HelperFailure && (HELPER_ERRORS as readonly string[]).includes(err.code)) {
        throw err
      }
      this.close()
      throw err
    }
  }

  private async reply(id: number, maxReply: number): Promise<HelperReply> {
    const line = await this.running.out.line(HEADER_MAX_BYTES)
    if (line === null) throw new HelperFailure('closed')
    const header = parseHeader(line, id, maxReply)
    if (!header.ok) throw new HelperFailure(helperError(header.meta))
    const payload = await this.running.out.bytes(header.length)
    if (payload === null) throw new HelperFailure('closed')
    return { meta: header.meta, payload }
  }
}
