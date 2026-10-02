import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  type ChatExportResult,
  type ChatSaveResult,
  chatMarkdown,
  normalizeChatSession,
} from '../shared/chatSessions'
import { type RedactText, redactChatSession } from '../shared/redactionTargets'
import type { ChatSessionStore } from './chatSessions'

const SAVE_FILE_MAX = 5 * 1024 * 1024

function safeName(raw: unknown, fallback: string): string {
  const clean =
    typeof raw === 'string'
      ? [...raw].map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '-' : ch))
      : []
  const name = basename(clean.join(''))
  return name.trim().slice(0, 120) || fallback
}

async function saveWithDialog(
  sender: Electron.WebContents,
  defaultName: string,
  content: string,
): Promise<ChatExportResult> {
  const win = BrowserWindow.fromWebContents(sender)
  const options: Electron.SaveDialogOptions = { defaultPath: defaultName }
  const picked = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' }
  try {
    writeFileSync(picked.filePath, content, 'utf8')
    return { ok: true, path: picked.filePath }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function saveRedacted(
  store: ChatSessionStore,
  raw: unknown,
  redact: RedactText,
): Promise<ChatSaveResult> {
  const session = normalizeChatSession(raw)
  if (!session) return store.save(raw)
  try {
    return store.save(await redactChatSession(session, redact))
  } catch {
    return { ok: false, error: 'redaction-failed' }
  }
}

export function registerChatSessionIpc(store: ChatSessionStore, redact: RedactText): void {
  ipcMain.handle('chat:list', () => store.list())
  ipcMain.handle('chat:get', (_e, id: unknown) => (typeof id === 'string' ? store.get(id) : null))
  ipcMain.handle('chat:save', (_e, session: unknown) => saveRedacted(store, session, redact))
  ipcMain.handle('chat:rename', (_e, id: unknown, title: unknown) =>
    typeof id === 'string' && typeof title === 'string' ? store.rename(id, title) : null,
  )
  ipcMain.handle('chat:remove', (_e, id: unknown) =>
    typeof id === 'string' ? store.remove(id) : false,
  )
  ipcMain.handle('chat:export', (e, id: unknown) => {
    const session = typeof id === 'string' ? store.get(id) : null
    if (!session) return { ok: false, error: 'unknown-session' }
    return saveWithDialog(
      e.sender,
      safeName(`${session.title}.md`, 'chat.md'),
      chatMarkdown(session),
    )
  })
  ipcMain.handle('chat:save-file', (e, name: unknown, content: unknown) => {
    if (typeof content !== 'string' || content.length > SAVE_FILE_MAX) {
      return { ok: false, error: 'invalid-content' }
    }
    return saveWithDialog(e.sender, safeName(name, 'snippet.txt'), content)
  })
}
