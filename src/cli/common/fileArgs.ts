import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { type FileTarget, type OpenFileError, openTargetKind } from '../../shared/files/openFiles'

export interface FileProbe {
  cwd: string
  isFile: (path: string) => boolean
  isDir?: (path: string) => boolean
  home?: string
}

const POSITION_SUFFIX = /^(.+?):(\d+)(?::(\d+))?$/

function absolute(arg: string, probe: FileProbe): string {
  const home = probe.home ?? homedir()
  if (arg === '~') return home
  if (arg.startsWith('~/')) return join(home, arg.slice(2))
  return resolve(probe.cwd, arg)
}

export function parseFileArg(arg: string, probe: FileProbe): FileTarget {
  const path = absolute(arg, probe)
  if (probe.isFile(path)) return { path }
  const positioned = POSITION_SUFFIX.exec(arg)
  if (!positioned) return { path }
  const line = Number(positioned[2])
  const column = positioned[3] ? Number(positioned[3]) : undefined
  if (line < 1) return { path }
  return {
    path: absolute(positioned[1], probe),
    line,
    ...(column && column > 0 ? { column } : {}),
  }
}

type OpenTarget =
  | { kind: 'url'; url: string }
  | { kind: 'stdin' }
  | { kind: 'folder'; path: string }
  | { kind: 'file'; file: FileTarget }

export function openTarget(word: string, probe: FileProbe): OpenTarget {
  const kind = openTargetKind(word)
  if (kind === 'url') return { kind: 'url', url: word }
  if (kind === 'stdin') return { kind: 'stdin' }
  const file = parseFileArg(word, probe)
  return probe.isDir?.(file.path) ? { kind: 'folder', path: file.path } : { kind: 'file', file }
}

const REVEAL_REFUSALS: Record<string, string> = {
  'outside-home': 'folders show only under the home folder',
  'not-found': 'no such folder',
  'not-a-directory': 'not a folder',
  'outside-sandbox': 'a sandboxed workspace cannot show folders',
}

export function revealRefusalLine(path: string, error: string, message?: string): string {
  return `ostia: ${path}: ${REVEAL_REFUSALS[error] ?? message ?? error}`
}

const REFUSALS: Record<OpenFileError, string> = {
  'not-found': 'no such file',
  directory: 'is a directory',
  'not-a-file': 'not a regular file',
  unreadable: 'permission denied',
  'outside-sandbox': 'outside what a sandboxed workspace may open',
}

export function refusalLine(path: string, error: OpenFileError): string {
  return `ostia: ${path}: ${REFUSALS[error]}`
}

const DIFF_REFUSALS: Record<string, string> = {
  ...REFUSALS,
  binary: 'is not a text file',
  'too-large': 'is too large to compare',
}

export function diffRefusalLine(path: string | undefined, error: string, message?: string): string {
  const reason = DIFF_REFUSALS[error] ?? message ?? error
  return path ? `ostia diff: ${path}: ${reason}` : `ostia diff: ${reason}`
}
