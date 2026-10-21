import { statSync } from 'node:fs'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { ARTIFACTS_ENV } from '../../shared/artifacts/artifacts'
import {
  type DiffFilesResult,
  type FileTarget,
  type OpenFilesResult,
  openTargetKind,
  type RevealFolderResult,
} from '../../shared/files/openFiles'
import { FlagError, type ParsedArgs, parseArgs } from '../common/args'
import { fail, failVerb } from '../common/failure'
import {
  diffRefusalLine,
  type FileProbe,
  openTarget,
  parseFileArg,
  refusalLine,
  revealRefusalLine,
} from '../common/fileArgs'
import { tsvLine } from '../common/lineField'
import { confirmFilesOpen, confirmPaneOpen } from '../common/readBack'
import { captureStdin, TTY_NOTICE } from '../common/stdinCapture'
import { usageOf } from '../common/usageTable'

const FILE_PROBE: FileProbe = {
  cwd: process.cwd(),
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDir: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

interface OpenHow {
  background: boolean
  wait: boolean
}

export interface Opened {
  problems: string[]
  shown: string[]
}

async function openFilesIn(
  conn: MessageConnection,
  files: FileTarget[],
  how: OpenHow,
): Promise<Opened> {
  if (files.length === 0) return { problems: [], shown: [] }
  const res = await conn.sendRequest<OpenFilesResult>('file.open', {
    files,
    ...(how.background ? { background: true } : {}),
    ...(how.wait ? { wait: true } : {}),
  })
  if (!res.ok) return { problems: [`ostia open: ${res.message}`], shown: [] }
  const refused = res.results.flatMap((r) => (r.ok ? [] : [refusalLine(r.path, r.error)]))
  if (how.wait) {
    const ended = res.waited !== 'closed' && refused.length < res.results.length
    return { problems: ended ? [...refused, WAIT_ENDED] : refused, shown: [] }
  }
  const paths = res.results.flatMap((r) => (r.ok ? [r.path] : []))
  if (paths.length === 0) return { problems: refused, shown: [] }
  const seen = await confirmFilesOpen(conn, paths)
  if (!seen.ok) return { problems: [...refused, seen.reason], shown: [] }
  return { problems: refused, shown: seen.value.map((o) => tsvLine([o.paneId, o.path])) }
}

async function revealFolderIn(conn: MessageConnection, path: string): Promise<Opened> {
  const res = await conn.sendRequest<RevealFolderResult>('file.reveal', { path })
  return res.ok
    ? { problems: [], shown: [tsvLine(['files', path])] }
    : { problems: [revealRefusalLine(path, res.error, res.message)], shown: [] }
}

async function openUrlIn(
  conn: MessageConnection,
  url: string,
  background: boolean,
): Promise<Opened> {
  const res = await conn.sendRequest<{
    ok: boolean
    tabId?: string
    error?: string
    message?: string
  }>('browse.open', { url, ...(background ? { background: true } : {}) })
  if (!res.ok)
    return { problems: [`ostia: ${url}: ${res.message ?? res.error ?? 'failed'}`], shown: [] }
  if (!res.tabId) return { problems: [`ostia open: ${url} names no browser pane`], shown: [] }
  const seen = await confirmPaneOpen(conn, res.tabId, url)
  return seen.ok
    ? { problems: [], shown: [tsvLine([seen.value, url])] }
    : { problems: [seen.reason], shown: [] }
}

const WAIT_ENDED = 'ostia: the wait ended before the tab was closed'

type FolderOpener = (conn: MessageConnection, path: string, background: boolean) => Promise<Opened>

const OPEN_FLAG_WORDS: ReadonlySet<string> = new Set([
  '-b',
  '--background',
  '-w',
  '--wait',
  '--name',
])

function looksLikePath(word: string): boolean {
  if (word === '-' || OPEN_FLAG_WORDS.has(word)) return true
  if (word.startsWith('-')) return false
  return (
    openTargetKind(word) === 'url' ||
    word.includes('/') ||
    word.startsWith('.') ||
    word.startsWith('~')
  )
}

export function opensOffline(word: string): boolean {
  return looksLikePath(word) || FILE_PROBE.isFile(parseFileArg(word, FILE_PROBE).path)
}

export async function opensAsTarget(conn: MessageConnection, word: string): Promise<boolean> {
  if (looksLikePath(word)) return true
  if (word.startsWith('-')) return false
  const { path } = parseFileArg(word, FILE_PROBE)
  if (!FILE_PROBE.isFile(path) && !FILE_PROBE.isDir?.(path)) return false
  const [extensions, commands] = await Promise.all([
    conn.sendRequest<{ id: string; verb?: string }[]>('ext.list'),
    conn.sendRequest<{ id: string }[]>('command.list'),
  ])
  const claimed = [
    ...extensions.flatMap((e) => (e.verb ? [e.id, e.verb] : [e.id])),
    ...commands.map((c) => c.id),
  ]
  return !claimed.includes(word)
}

export async function runOpenFiles(
  conn: MessageConnection,
  args: string[],
  folderIn: FolderOpener = revealFolderIn,
): Promise<void> {
  let parsed: ParsedArgs<'name', never, 'background' | 'wait'>
  try {
    parsed = parseArgs(args, {
      values: { name: '--name' },
      booleans: { background: '-b, --background', wait: '-w, --wait' },
    })
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    return fail(`ostia open: ${err.message}\n${usageOf('open')}`)
  }
  const targets = parsed.positional.map((word) => openTarget(word, FILE_PROBE))
  if (targets.length === 0) return fail(usageOf('open'))
  const { background, wait } = parsed.booleans
  const fromStdin = targets.filter((t) => t.kind === 'stdin').length
  if (fromStdin > 1) return fail('ostia open: only one - reads stdin')
  if (parsed.values.name !== undefined && fromStdin === 0) {
    return fail('ostia open: --name goes with -')
  }
  const problems: string[] = []
  const files: FileTarget[] = []
  for (const target of targets) {
    if (target.kind === 'file') files.push(target.file)
    if (target.kind !== 'stdin') continue
    if (process.stdin.isTTY) console.error(TTY_NOTICE)
    const captured = await captureStdin({
      dir: readEnv(ARTIFACTS_ENV),
      name: parsed.values.name,
      stream: process.stdin,
      now: new Date(),
    })
    if (captured.ok) files.push({ path: captured.path })
    else problems.push(captured.message)
  }
  if (wait && files.length === 0 && problems.length === 0) {
    return fail('ostia open: --wait needs a file')
  }
  const shown: string[] = []
  const take = (opened: Opened): void => {
    problems.push(...opened.problems)
    shown.push(...opened.shown)
  }
  for (const target of targets) {
    if (target.kind === 'folder') take(await folderIn(conn, target.path, background))
    if (target.kind === 'url') take(await openUrlIn(conn, target.url, background))
  }
  take(await openFilesIn(conn, files, { background, wait }))
  for (const line of shown) console.log(line)
  for (const line of problems) console.error(line)
  if (problems.length > 0) process.exitCode = 1
}

export async function runDiffFiles(conn: MessageConnection, args: string[]): Promise<void> {
  let parsed: ParsedArgs<never, never, 'background' | 'wait'>
  try {
    parsed = parseArgs(args, {
      booleans: { background: '-b, --background', wait: '-w, --wait' },
    })
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    return failVerb(err.message)
  }
  if (parsed.positional.length !== 2) return fail(usageOf('diff'))
  const [original, modified] = parsed.positional.map((word) => parseFileArg(word, FILE_PROBE).path)
  const { background, wait } = parsed.booleans
  const res = await conn.sendRequest<DiffFilesResult>('file.diff', {
    original,
    modified,
    ...(background ? { background: true } : {}),
    ...(wait ? { wait: true } : {}),
  })
  if (!res.ok) return fail(diffRefusalLine(res.path, res.error, res.message))
  if (wait && res.waited !== 'closed') return fail(WAIT_ENDED)
  if (!wait) console.log('ok')
}
