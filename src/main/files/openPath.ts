import { statSync } from 'node:fs'
import { extname } from 'node:path'
import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from 'electron'
import { externalHref } from '../../shared/common/externalLinks'
import type { OpenPathResult } from '../../shared/types'
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
])

export function isProgram(path: string, mode: number, isFile: boolean): boolean {
  if (PROGRAM_EXTENSIONS.has(extname(path).toLowerCase())) return true
  return isFile && (mode & 0o111) !== 0
}

function locate(
  raw: unknown,
  roots: string[],
): { path: string; mode: number; isFile: boolean } | null {
  if (typeof raw !== 'string') return null
  const path = resolveSafe(raw, roots)
  if (!path) return null
  try {
    const stat = statSync(path)
    return { path, mode: stat.mode, isFile: stat.isFile() }
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
    if (isProgram(found.path, found.mode, found.isFile)) return { ok: false, error: 'program' }
    const error = await shell.openPath(found.path)
    return error ? { ok: false, error: 'failed' } : { ok: true }
  })
  ipcMain.handle('shell:open-link', (e, raw: unknown) => openLink(appWindows, e, raw))
  ipcMain.handle('shell:reveal', (_e, raw: unknown): OpenPathResult => {
    const found = locate(raw, roots)
    if (!found) return { ok: false, error: 'not-found' }
    shell.showItemInFolder(found.path)
    return { ok: true }
  })
}
