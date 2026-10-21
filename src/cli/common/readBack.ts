import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  actThenConfirm,
  confirmed,
  mismatch,
  pollEvery,
  type Settled,
} from '../../shared/common/actThenConfirm'

const READ_BACK_MS = 3000
const READ_BACK_POLL_MS = 100

interface PaneRow {
  paneId: string
  filePath?: string
}

interface WorkspaceRow {
  workspaceId: string
}

function readBack<T>(
  observe: () => Promise<Settled<T> | undefined>,
  missing: () => string,
): Promise<Settled<T>> {
  return actThenConfirm<T>({
    act: () => undefined,
    observe,
    signal: pollEvery(READ_BACK_POLL_MS),
    timeoutMs: READ_BACK_MS,
    onTimeout: () => mismatch(missing()),
  })
}

export function confirmFilesOpen(
  conn: MessageConnection,
  paths: readonly string[],
): Promise<Settled<{ path: string; paneId: string }[]>> {
  let absent = paths[0] ?? ''
  return readBack(
    async () => {
      const panes = await conn.sendRequest<PaneRow[]>('pane.list')
      const opened: { path: string; paneId: string }[] = []
      for (const path of paths) {
        const pane = panes.find((p) => p.filePath === path)
        if (!pane) {
          absent = path
          return undefined
        }
        opened.push({ path, paneId: pane.paneId })
      }
      return confirmed(opened)
    },
    () => `ostia open: ${absent} has no tab after opening it`,
  )
}

export function confirmPaneOpen(
  conn: MessageConnection,
  paneId: string,
  what: string,
): Promise<Settled<string>> {
  return readBack(
    async () => {
      const panes = await conn.sendRequest<PaneRow[]>('pane.list')
      return panes.some((p) => p.paneId === paneId) ? confirmed(paneId) : undefined
    },
    () => `ostia open: ${what} has no pane after opening it`,
  )
}

export function confirmWorkspace(
  conn: MessageConnection,
  workspaceId: string,
): Promise<Settled<string>> {
  return readBack(
    async () => {
      const rows = await conn.sendRequest<WorkspaceRow[]>('workspace.list')
      return rows.some((w) => w.workspaceId === workspaceId) ? confirmed(workspaceId) : undefined
    },
    () => `ostia workspace new: workspace ${workspaceId} is not in the workspace list`,
  )
}
