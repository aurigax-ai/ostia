import { type Stats, lstatSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export const STDIN_MAX_BYTES = 16 * 1024 * 1024
export const STDIN_NAME_MAX = 200
export const NO_ARTIFACT_FOLDER = 'ostia: stdin needs an artifact folder'
export const TTY_NOTICE = 'ostia: reading from the terminal; end with Ctrl+D'

const FORBIDDEN_NAME = /[/\\\0]/

export type NameVerdict = { ok: true; name: string } | { ok: false; message: string }

function two(n: number): string {
  return String(n).padStart(2, '0')
}

export function defaultStdinName(now: Date): string {
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  return `stdin-${day}-${time}.txt`
}

export function stdinFileName(name: string | undefined, now: Date): NameVerdict {
  if (name === undefined) return { ok: true, name: defaultStdinName(now) }
  if (name.length === 0 || name.length > STDIN_NAME_MAX) {
    return { ok: false, message: `ostia: --name must be 1 to ${STDIN_NAME_MAX} characters` }
  }
  if (FORBIDDEN_NAME.test(name)) {
    return { ok: false, message: 'ostia: --name is a file name, not a path' }
  }
  if (name.startsWith('.')) return { ok: false, message: 'ostia: --name cannot start with a dot' }
  return { ok: true, name }
}

export async function readCapped(
  stream: AsyncIterable<Buffer | string>,
  max: number = STDIN_MAX_BYTES,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += bytes.length
    if (size > max) return null
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function statOf(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function numbered(name: string, n: number): string {
  if (n === 1) return name
  const ext = extname(name)
  return `${ext ? name.slice(0, -ext.length) : name}-${n}${ext}`
}

export function writeNewFile(dir: string, name: string, content: Buffer): string {
  for (let n = 1; ; n += 1) {
    const path = join(dir, numbered(name, n))
    try {
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

export type CaptureResult = { ok: true; path: string } | { ok: false; message: string }

export interface CaptureInput {
  dir: string | undefined
  name: string | undefined
  stream: AsyncIterable<Buffer | string>
  now: Date
  max?: number
}

export async function captureStdin(input: CaptureInput): Promise<CaptureResult> {
  const verdict = stdinFileName(input.name, input.now)
  if (!verdict.ok) return verdict
  const folder = input.dir ? statOf(input.dir) : null
  if (!input.dir || !folder?.isDirectory()) return { ok: false, message: NO_ARTIFACT_FOLDER }
  const max = input.max ?? STDIN_MAX_BYTES
  const content = await readCapped(input.stream, max)
  if (content === null) {
    return {
      ok: false,
      message: `ostia: stdin is over ${Math.round(max / (1024 * 1024))} MiB; nothing was written`,
    }
  }
  try {
    return { ok: true, path: writeNewFile(input.dir, verdict.name, content) }
  } catch (err) {
    return { ok: false, message: `ostia: ${(err as Error).message}` }
  }
}
