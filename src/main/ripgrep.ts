import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { FileMatches, LineMatch } from '../shared/search'

export interface TextQuery {
  text: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  includeIgnored: boolean
}

export interface TextResults {
  files: FileMatches[]
  matches: number
  truncated: boolean
}

export interface FileList {
  paths: string[]
  truncated: boolean
}

export type RgFailureCode = 'rg-missing' | 'invalid-pattern' | 'failed' | 'cancelled'

export function ripgrepPath(appPath: string, platform: string, arch: string): string {
  return join(
    appPath.replace(/\.asar$/, '.asar.unpacked'),
    'node_modules',
    '@vscode',
    `ripgrep-${platform}-${arch}`,
    'bin',
    platform === 'win32' ? 'rg.exe' : 'rg',
  )
}

export type RgOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: RgFailureCode; message: string }

export const MATCH_LIMIT = 2000
export const FILE_LIST_LIMIT = 50_000
export const PREVIEW_CHARS = 240
export const PREVIEW_LEAD = 40
export const RG_TIMEOUT_MS = 15_000
const STDERR_MAX = 4000

const COMMON_ARGS = ['--no-config', '--hidden', '--glob', '!.git', '--no-messages']

function scopeArgs(includeIgnored: boolean): string[] {
  return includeIgnored ? [...COMMON_ARGS, '--no-ignore'] : COMMON_ARGS
}

export function textArgv(q: TextQuery): string[] {
  return [
    '--json',
    ...scopeArgs(q.includeIgnored),
    '--max-filesize',
    '2M',
    q.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(q.regex ? [] : ['--fixed-strings']),
    ...(q.wholeWord ? ['--word-regexp'] : []),
    '--',
    q.text,
    '.',
  ]
}

export function filesArgv(includeIgnored: boolean): string[] {
  return ['--files', ...scopeArgs(includeIgnored), '.']
}

export function relativePath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path
}

function charOffset(bytes: Buffer, offset: number): number {
  return bytes.subarray(0, offset).toString('utf8').length
}

export function preview(
  line: string,
  ranges: [number, number][],
): { text: string; ranges: [number, number][] } {
  const indent = line.length - line.trimStart().length
  const first = ranges[0]?.[0] ?? indent
  const start = first < indent ? first : Math.max(indent, first - PREVIEW_LEAD)
  const end = start + PREVIEW_CHARS
  const shifted: [number, number][] = []
  for (const [from, to] of ranges) {
    if (from >= end) break
    shifted.push([from - start, Math.min(to, end) - start])
  }
  return { text: line.slice(start, end), ranges: shifted }
}

export function parseMatch(raw: string): { path: string; match: LineMatch } | null {
  let event: unknown
  try {
    event = JSON.parse(raw)
  } catch {
    return null
  }
  const e = event as {
    type?: unknown
    data?: {
      path?: { text?: unknown }
      lines?: { text?: unknown }
      line_number?: unknown
      submatches?: { start?: unknown; end?: unknown }[]
    }
  }
  if (e?.type !== 'match' || !e.data) return null
  const path = e.data.path?.text
  const text = e.data.lines?.text
  const line = e.data.line_number
  if (typeof path !== 'string' || typeof text !== 'string' || typeof line !== 'number') return null
  const full = text.replace(/\r?\n$/, '')
  const bytes = Buffer.from(text, 'utf8')
  const ranges: [number, number][] = []
  for (const sub of e.data.submatches ?? []) {
    if (typeof sub.start !== 'number' || typeof sub.end !== 'number') continue
    const from = Math.min(charOffset(bytes, sub.start), full.length)
    const to = Math.min(charOffset(bytes, sub.end), full.length)
    if (to > from) ranges.push([from, to])
  }
  const shown = preview(full, ranges)
  return {
    path: relativePath(path),
    match: { line, column: (ranges[0]?.[0] ?? 0) + 1, text: shown.text, ranges: shown.ranges },
  }
}

function failureOf(stderr: string): RgOutcome<never> {
  const message = stderr.trim().split('\n').slice(0, 8).join('\n')
  const invalid = /regex parse error|error parsing glob|invalid glob/i.test(stderr)
  return { ok: false, error: invalid ? 'invalid-pattern' : 'failed', message }
}

export function runRg(
  bin: string,
  root: string,
  argv: string[],
  onLine: (line: string) => boolean,
  signal?: AbortSignal,
): Promise<RgOutcome<{ stopped: boolean }>> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'cancelled', message: '' })
      return
    }
    const child = spawn(bin, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stopped = false
    let settled = false
    let stderr = ''
    const stop = (): void => {
      stopped = true
      child.kill()
    }
    const timer = setTimeout(stop, RG_TIMEOUT_MS)
    signal?.addEventListener('abort', stop)
    const settle = (outcome: RgOutcome<{ stopped: boolean }>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve(signal?.aborted ? { ok: false, error: 'cancelled', message: '' } : outcome)
    }
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!stopped && !onLine(line)) stop()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) =>
      settle(
        err.code === 'ENOENT'
          ? { ok: false, error: 'rg-missing', message: 'ripgrep is missing from this build' }
          : { ok: false, error: 'failed', message: err.message },
      ),
    )
    child.on('close', (code) => {
      if (stopped || code === 0 || code === 1 || !stderr.trim())
        settle({ ok: true, value: { stopped } })
      else settle(failureOf(stderr))
    })
  })
}

export async function searchText(
  bin: string,
  root: string,
  q: TextQuery,
  signal?: AbortSignal,
): Promise<RgOutcome<TextResults>> {
  const byPath = new Map<string, LineMatch[]>()
  let matches = 0
  let truncated = false
  const run = await runRg(
    bin,
    root,
    textArgv(q),
    (line) => {
      const hit = parseMatch(line)
      if (!hit) return true
      const list = byPath.get(hit.path)
      if (list) list.push(hit.match)
      else byPath.set(hit.path, [hit.match])
      matches++
      if (matches < MATCH_LIMIT) return true
      truncated = true
      return false
    },
    signal,
  )
  if (!run.ok) return run
  const files = [...byPath]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, list]) => ({ path, matches: list }))
  return { ok: true, value: { files, matches, truncated: truncated || run.value.stopped } }
}

export async function listFiles(
  bin: string,
  root: string,
  includeIgnored: boolean,
  signal?: AbortSignal,
): Promise<RgOutcome<FileList>> {
  const paths: string[] = []
  const run = await runRg(
    bin,
    root,
    filesArgv(includeIgnored),
    (line) => {
      paths.push(relativePath(line))
      return paths.length < FILE_LIST_LIMIT
    },
    signal,
  )
  if (!run.ok) return run
  return { ok: true, value: { paths, truncated: run.value.stopped } }
}
