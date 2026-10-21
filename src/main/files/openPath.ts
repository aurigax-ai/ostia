import { type Stats, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from 'electron'
import { externalHref } from '../../shared/common/externalLinks'
import type { OpenPathResult } from '../../shared/files/filesApi'
import { readFileSlice } from '../gateway/workspaceFiles'
import { fromAppWindow } from '../platform/appWindowSender'
import { resolveSafe } from '../platform/pathGuard'

const PROGRAM_EXTENSIONS = new Set([
  '.desktop',
  '.appimage',
  '.run',
  '.sh',
  '.bash',
  '.zsh',
  '.command',
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.app',
  '.jar',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.hta',
  '.lnk',
  '.url',
  '.scr',
  '.pif',
  '.cpl',
  '.msc',
  '.reg',
  '.py',
  '.pyw',
  '.terminal',
  '.tool',
  '.fileloc',
  '.webloc',
  '.inetloc',
  '.workflow',
  '.pkg',
  '.mpkg',
  '.prefpane',
])

const SNIFF_BYTES = 4096

const PROGRAM_MAGICS = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0x4d, 0x5a],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
].map((magic) => Buffer.from(magic))

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const SHEBANG = Buffer.from('#!')
const DESKTOP_ENTRY = Buffer.from('[Desktop Entry]')
const NEWLINE = 0x0a
const SPACE = 0x20
const TAB = 0x09

function startsWith(head: Buffer, prefix: Buffer): boolean {
  return head.subarray(0, prefix.length).equals(prefix)
}

function startsLine(head: Buffer, at: number, textStart: number): boolean {
  let before = at - 1
  while (before >= textStart && (head[before] === SPACE || head[before] === TAB)) before--
  return before < textStart || head[before] === NEWLINE
}

function hasDesktopEntry(head: Buffer, textStart: number): boolean {
  for (let at = head.indexOf(DESKTOP_ENTRY); at >= 0; at = head.indexOf(DESKTOP_ENTRY, at + 1)) {
    if (startsLine(head, at, textStart)) return true
  }
  return false
}

export function isProgram(path: string, mode: number, isFile: boolean): boolean {
  if (PROGRAM_EXTENSIONS.has(extname(path).toLowerCase())) return true
  return isFile && (mode & 0o111) !== 0
}

function looksLikeProgram(head: Buffer): boolean {
  if (PROGRAM_MAGICS.some((magic) => startsWith(head, magic))) return true
  const textStart = startsWith(head, UTF8_BOM) ? UTF8_BOM.length : 0
  if (startsWith(head.subarray(textStart), SHEBANG)) return true
  return hasDesktopEntry(head, textStart)
}

async function fileHead(path: string): Promise<Buffer | null> {
  const read = await readFileSlice(path, SNIFF_BYTES, 0)
  if (!read.ok) return null
  const { text, base64 } = read.value
  return text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(base64 ?? '', 'base64')
}

async function launchesProgram(path: string, info: Stats): Promise<boolean> {
  if (isProgram(path, info.mode, info.isFile())) return true
  if (!info.isFile()) return false
  const head = await fileHead(path)
  return head === null || looksLikeProgram(head)
}

async function unchangedSince(path: string, before: Stats): Promise<boolean> {
  try {
    const now = await stat(path)
    return now.dev === before.dev && now.ino === before.ino && now.mode === before.mode
  } catch {
    return false
  }
}

export async function canOpenDefault(path: string, info: Stats): Promise<boolean> {
  return !(await launchesProgram(path, info))
}

export async function openUnlessProgram(
  path: string,
  info: Stats,
  openPath: (path: string) => Promise<string>,
): Promise<OpenPathResult> {
  if (await launchesProgram(path, info)) return { ok: false, error: 'program' }
  if (!(await unchangedSince(path, info))) return { ok: false, error: 'not-found' }
  const error = await openPath(path)
  return error ? { ok: false, error: 'failed' } : { ok: true }
}

function locate(raw: unknown, roots: string[]): { path: string; info: Stats } | null {
  if (typeof raw !== 'string') return null
  const path = resolveSafe(raw, roots)
  if (!path) return null
  try {
    return { path, info: statSync(path) }
  } catch {
    return null
  }
}

export async function openLink(
  appWindows: () => Iterable<BrowserWindow>,
  e: IpcMainInvokeEvent,
  raw: unknown,
): Promise<boolean> {
  if (!fromAppWindow(appWindows, e) || typeof raw !== 'string') return false
  const href = externalHref(raw, { apps: true })
  if (!href) return false
  try {
    await shell.openExternal(href)
    return true
  } catch {
    return false
  }
}

export function registerOpenPathIpc(
  roots: string[],
  appWindows: () => Iterable<BrowserWindow>,
): void {
  ipcMain.handle('shell:open-default', async (_e, raw: unknown): Promise<OpenPathResult> => {
    const found = locate(raw, roots)
    if (!found) return { ok: false, error: 'not-found' }
    return openUnlessProgram(found.path, found.info, (path) => shell.openPath(path))
  })
  ipcMain.handle('shell:can-open-default', async (_e, raw: unknown): Promise<boolean> => {
    const found = locate(raw, roots)
    return found !== null && canOpenDefault(found.path, found.info)
  })
  ipcMain.handle('shell:open-link', (e, raw: unknown) => openLink(appWindows, e, raw))
  ipcMain.handle('shell:reveal', (_e, raw: unknown): OpenPathResult => {
    const found = locate(raw, roots)
    if (!found) return { ok: false, error: 'not-found' }
    shell.showItemInFolder(found.path)
    return { ok: true }
  })
}
