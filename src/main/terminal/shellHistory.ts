import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { ipcMain } from 'electron'
import { LRUCache } from 'lru-cache'
import type { ShellHistoryEntry } from '../../shared/terminal/ptyApi'
import { type SandboxReadRules, visibleInSandbox } from '../sandbox/visibility'
import { readShellState } from './shellCommands'

export const HISTORY_READ_MAX_BYTES = 4 * 1024 * 1024
export const HISTORY_ENTRIES_MAX = 20_000

const MAX_CACHED_FILES = 8
const ZSH_META = 0x83
const ZSH_EXTENDED = /^: (\d+):\d+;/
const BASH_TIME = /^#(\d+)$/
const NEWLINE = 0x0a

export type HistoryShell = 'zsh' | 'bash'

export function historyShell(shell: string): HistoryShell | null {
  const name = basename(shell).replace(/^-/, '')
  return name === 'zsh' || name === 'bash' ? name : null
}

function unmetafy(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length)
  let length = 0
  for (let i = 0; i < bytes.length; i++) {
    const meta = bytes[i] === ZSH_META && i + 1 < bytes.length
    out[length++] = meta ? bytes[++i] ^ 0x20 : bytes[i]
  }
  return out.subarray(0, length)
}

const seconds = (digits: string): number => Number(digits) * 1000

function zshEntry(lines: readonly string[]): ShellHistoryEntry | null {
  const text = lines.join('\n')
  const extended = ZSH_EXTENDED.exec(text)
  const command = (extended ? text.slice(extended[0].length) : text).trim()
  return command ? { command, time: extended ? seconds(extended[1]) : null } : null
}

export function parseZshHistory(bytes: Buffer): ShellHistoryEntry[] {
  const entries: ShellHistoryEntry[] = []
  let open: string[] = []
  for (const line of unmetafy(bytes).toString('utf8').split('\n')) {
    if (line.endsWith('\\')) {
      open.push(line.slice(0, -1))
      continue
    }
    const entry = zshEntry([...open, line])
    if (entry) entries.push(entry)
    open = []
  }
  return entries
}

export function parseBashHistory(text: string): ShellHistoryEntry[] {
  const lines = text.split('\n')
  if (!lines.some((line) => BASH_TIME.test(line))) {
    return lines.flatMap((line) => (line.trim() ? [{ command: line.trim(), time: null }] : []))
  }
  const entries: ShellHistoryEntry[] = []
  let time: number | null = null
  let open: string[] = []
  const close = (): void => {
    const command = open.join('\n').trim()
    if (command) entries.push({ command, time })
    open = []
  }
  for (const line of lines) {
    const stamp = BASH_TIME.exec(line)
    if (!stamp) {
      open.push(line)
      continue
    }
    close()
    time = seconds(stamp[1])
  }
  close()
  return entries
}

function parseHistory(bytes: Buffer, shell: HistoryShell): ShellHistoryEntry[] {
  const entries =
    shell === 'zsh' ? parseZshHistory(bytes) : parseBashHistory(bytes.toString('utf8'))
  return entries.slice(-HISTORY_ENTRIES_MAX)
}

function fromWholeLine(bytes: Buffer): Buffer {
  const firstBreak = bytes.indexOf(NEWLINE)
  return firstBreak < 0 ? Buffer.alloc(0) : bytes.subarray(firstBreak + 1)
}

interface CachedHistory {
  size: number
  mtimeMs: number
  entries: ShellHistoryEntry[]
}

export class ShellHistoryFiles {
  private readonly cache = new LRUCache<string, CachedHistory>({ max: MAX_CACHED_FILES })

  async read(file: string, shell: HistoryShell): Promise<ShellHistoryEntry[]> {
    if (!isAbsolute(file) || file.includes('\0')) return []
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null)
    if (!handle) return []
    try {
      const info = await handle.stat()
      if (!info.isFile()) return []
      const key = `${shell}:${file}`
      const hit = this.cache.get(key)
      if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.entries
      const start = Math.max(0, info.size - HISTORY_READ_MAX_BYTES)
      const buffer = Buffer.alloc(info.size - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      const bytes = buffer.subarray(0, bytesRead)
      const entries = parseHistory(start > 0 ? fromWholeLine(bytes) : bytes, shell)
      this.cache.set(key, { size: info.size, mtimeMs: info.mtimeMs, entries })
      return entries
    } catch {
      return []
    } finally {
      await handle.close()
    }
  }
}

export interface HistoryPane {
  owners: { has: (senderId: string) => boolean }
  localPrompt: boolean
  shell: string
  stateFile: string | null
  rules: SandboxReadRules | null
}

export interface ShellHistoryDeps {
  enabled: () => boolean
  pane: (paneId: string) => HistoryPane | null
  files: ShellHistoryFiles
}

async function shownInSandbox(file: string, rules: SandboxReadRules): Promise<boolean> {
  try {
    return visibleInSandbox(await realpath(file), rules)
  } catch {
    return false
  }
}

export async function paneHistory(
  deps: ShellHistoryDeps,
  senderId: string,
  paneId: unknown,
): Promise<ShellHistoryEntry[]> {
  if (typeof paneId !== 'string' || !deps.enabled()) return []
  const pane = deps.pane(paneId)
  if (!pane?.owners.has(senderId) || !pane.localPrompt) return []
  const shell = historyShell(pane.shell)
  if (!shell) return []
  const file = (await readShellState(pane.stateFile))?.histFile
  if (!file) return []
  if (pane.rules && !(await shownInSandbox(file, pane.rules))) return []
  return deps.files.read(file, shell)
}

export function registerShellHistoryIpc(deps: ShellHistoryDeps): void {
  ipcMain.handle('pty:history', (e, paneId: unknown) =>
    paneHistory(deps, String(e.sender.id), paneId),
  )
}
