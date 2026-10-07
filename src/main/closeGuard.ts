import { type BrowserWindow, ipcMain } from 'electron'
import type { PaneActivity, RunningGroup } from '../shared/types'

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
  late: unknown = gone,
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
    if (timeoutMs !== undefined) timer = setTimeout(() => settle(late), timeoutMs)
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
    const { workspaceId, workspace, commands, agents, files } = entry as Record<string, unknown>
    if (typeof workspaceId !== 'string' || typeof workspace !== 'string') continue
    const agentCommands = strings(agents)
    groups.push({
      workspaceId: workspaceId.slice(0, TEXT_MAX),
      workspace: workspace.slice(0, TEXT_MAX),
      commands: strings(commands),
      ...(agentCommands.length > 0 ? { agents: agentCommands } : {}),
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
    const agents = next.agents?.length ?? 0
    const loses = next.commands.length > 0 || agents > 0 || next.files.length > 0 || count > 0
    if (loses || next.unanswered) out.push(next)
  }
  return out
}

export interface PaneProcess extends PaneActivity {
  paneId: string
  workspaceId: string
}

export interface WorkspaceName {
  id: string
  name: string
}

export function groupsFromPtys(
  workspaces: readonly WorkspaceName[],
  processes: readonly PaneProcess[],
  kept: ReadonlySet<string>,
  unanswered: boolean,
): RunningGroup[] {
  return workspaces.map((workspace) => {
    const commands: string[] = []
    const agents: string[] = []
    for (const pane of processes) {
      if (pane.workspaceId !== workspace.id || kept.has(pane.paneId)) continue
      if (pane.agentRunning) agents.push(pane.program ?? '')
      else if (pane.program !== null) commands.push(pane.program)
    }
    return {
      workspaceId: workspace.id,
      workspace: workspace.name,
      commands,
      ...(agents.length > 0 ? { agents } : {}),
      files: [],
      ...(unanswered ? { unanswered: true } : {}),
    }
  })
}

export interface QuitCheck {
  scratchFiles: (workspaceId: string) => number
  kept: readonly string[]
  workspacesOf: (win: BrowserWindow) => readonly WorkspaceName[]
  processes: () => readonly PaneProcess[]
  confirmNative: (groups: readonly RunningGroup[]) => Promise<boolean>
}

const GONE = Symbol('gone')
const LATE = Symbol('late')

export async function confirmQuit(
  windows: readonly BrowserWindow[],
  asker: BrowserWindow | undefined,
  check: QuitCheck,
): Promise<boolean> {
  const live = windows.filter((w) => !w.isDestroyed())
  const answers = await Promise.all(
    live.map((w) => ask(w, 'window:running', [...check.kept], GONE, RUNNING_ANSWER_MS, LATE)),
  )
  const kept = new Set(check.kept)
  const answered: BrowserWindow[] = []
  const found: RunningGroup[] = []
  for (const [index, win] of live.entries()) {
    const answer = answers[index]
    if (answer === GONE || answer === LATE) {
      const workspaces = win.isDestroyed() ? [] : check.workspacesOf(win)
      found.push(...groupsFromPtys(workspaces, check.processes(), kept, answer === LATE))
    } else {
      answered.push(win)
      found.push(...parseRunningGroups(answer))
    }
  }
  const groups = withScratchFiles(found, check.scratchFiles)
  if (groups.length === 0) return true
  const showing = answered.filter((w) => !unresponsive(w))
  const target = asker && showing.includes(asker) ? asker : showing[0]
  if (!target) return check.confirmNative(groups)
  if (target.isMinimized()) target.restore()
  target.focus()
  return (await ask(target, 'window:confirm-close', groups, true)) === true
}

export function freezeAll(windows: readonly BrowserWindow[]): void {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send('window:freeze')
}
