import { type BrowserWindow, ipcMain } from 'electron'
import type { RunningGroup } from '../shared/types'

interface PendingAnswer {
  senderId: number
  settle: (value: unknown) => void
}

let lastRequestId = 0
const pending = new Map<number, PendingAnswer>()

const GROUPS_MAX = 64
const ITEMS_MAX = 32
const TEXT_MAX = 512

export function registerCloseGuard(): void {
  ipcMain.on('window:close-answer', (e, requestId: number, value: unknown) => {
    const answer = pending.get(requestId)
    if (answer && answer.senderId === e.sender.id) answer.settle(value)
  })
}

function unresponsive(win: BrowserWindow): boolean {
  return win.isDestroyed() || win.webContents.isLoading() || win.webContents.isCrashed()
}

export const RUNNING_ANSWER_MS = 2_000

export function ask(
  win: BrowserWindow,
  channel: string,
  payload: unknown,
  gone: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  if (unresponsive(win)) return Promise.resolve(gone)
  const contents = win.webContents
  return new Promise((resolve) => {
    const requestId = ++lastRequestId
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (value: unknown): void => {
      if (!pending.has(requestId)) return
      pending.delete(requestId)
      if (timer) clearTimeout(timer)
      contents.removeListener('render-process-gone', onGone)
      contents.removeListener('destroyed', onGone)
      resolve(value)
    }
    const onGone = (): void => settle(gone)
    contents.once('render-process-gone', onGone)
    contents.once('destroyed', onGone)
    pending.set(requestId, { senderId: contents.id, settle })
    if (timeoutMs !== undefined) timer = setTimeout(onGone, timeoutMs)
    contents.send(channel, requestId, payload)
  })
}

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is string => typeof s === 'string')
    .slice(0, ITEMS_MAX)
    .map((s) => s.slice(0, TEXT_MAX))
}

export function parseRunningGroups(raw: unknown): RunningGroup[] {
  if (!Array.isArray(raw)) return []
  const groups: RunningGroup[] = []
  for (const entry of raw.slice(0, GROUPS_MAX)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { workspaceId, workspace, commands, files } = entry as Record<string, unknown>
    if (typeof workspaceId !== 'string' || typeof workspace !== 'string') continue
    groups.push({
      workspaceId: workspaceId.slice(0, TEXT_MAX),
      workspace: workspace.slice(0, TEXT_MAX),
      commands: strings(commands),
      files: strings(files),
    })
  }
  return groups
}

export function withScratchFiles(
  groups: readonly RunningGroup[],
  scratchFiles: (workspaceId: string) => number,
): RunningGroup[] {
  const out: RunningGroup[] = []
  for (const group of groups) {
    const count = scratchFiles(group.workspaceId)
    const next = count > 0 ? { ...group, scratchFiles: count } : group
    if (next.commands.length > 0 || next.files.length > 0 || count > 0) out.push(next)
  }
  return out
}

export async function confirmQuit(
  windows: readonly BrowserWindow[],
  asker: BrowserWindow | undefined,
  scratchFiles: (workspaceId: string) => number,
  kept: readonly string[] = [],
): Promise<boolean> {
  const live = windows.filter((w) => !w.isDestroyed())
  const answers = await Promise.all(
    live.map((w) => ask(w, 'window:running', [...kept], [], RUNNING_ANSWER_MS)),
  )
  const groups = withScratchFiles(answers.flatMap(parseRunningGroups), scratchFiles)
  if (groups.length === 0) return true
  const target = asker && !unresponsive(asker) ? asker : live.find((w) => !unresponsive(w))
  if (!target) return true
  if (target.isMinimized()) target.restore()
  target.focus()
  return (await ask(target, 'window:confirm-close', groups, true)) === true
}

export function freezeAll(windows: readonly BrowserWindow[]): void {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send('window:freeze')
}
