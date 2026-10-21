import type { InboxEntry, WorkspaceChip } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { BrowserWindow } from 'electron'
import { type PaneIdentity, windowOfWorkspace } from '../control/idRegistry'
import {
  firstKnownOwner,
  inboxEntriesForWindow,
  workspaceChipsForWindow,
} from '../extensions/workspaceChips'
import type { RemoteFolders } from '../files/remoteFolders'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import type { WindowBroker } from './windowBroker'

interface WindowSendDeps {
  windows: Map<string, BrowserWindow>
  services: {
    broker: WindowBroker | null
  }
}

export type WindowSend = ReturnType<typeof createWindowSend>

export function createWindowSend({ windows, services }: WindowSendDeps) {
  function broadcast(channel: string, payload: unknown): void {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  function publishRemoteFolders(folders: RemoteFolders): void {
    for (const [windowId, win] of windows) {
      if (win.isDestroyed()) continue
      win.webContents.send('remote-files:folders-changed', folders.forWindow(windowId))
    }
  }

  function settingsChanged(): void {
    broadcast('settings:changed', undefined)
  }

  function primaryWindowId(): string | undefined {
    return services.broker?.windowIds()[0] ?? [...windows.keys()][0]
  }

  function windowIds(): string[] {
    return services.broker?.windowIds() ?? [...windows.keys()]
  }

  const workspaceWindowId = firstKnownOwner(
    (workspaceId) => services.broker?.windowOfWorkspace(workspaceId),
    windowOfWorkspace,
    windowForWorkspace,
  )

  function mainWindow(): BrowserWindow | undefined {
    return services.broker?.mainWindow() ?? [...windows.values()][0]
  }

  function publishWorkspaceChips(chips: WorkspaceChip[]): void {
    for (const [windowId, win] of windows) {
      if (win.isDestroyed()) continue
      win.webContents.send(
        'extensions:workspace-chips',
        workspaceChipsForWindow(chips, workspaceWindowId, windowId),
      )
    }
  }

  function publishInbox(entries: InboxEntry[]): void {
    for (const [windowId, win] of windows) {
      if (win.isDestroyed()) continue
      win.webContents.send(
        'extensions:inbox',
        inboxEntriesForWindow(entries, workspaceWindowId, windowId),
      )
    }
  }

  function sendToWindow(windowId: string, channel: string, payload: unknown): void {
    const win = windows.get(windowId)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  function sendToWorkspaceWindow(
    workspaceId: string | undefined,
    channel: string,
    payload: unknown,
  ): void {
    const windowId = workspaceId ? workspaceWindowId(workspaceId) : undefined
    const win = (windowId ? windows.get(windowId) : undefined) ?? mainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  function focusPaneInWindow(pane: PaneIdentity): boolean {
    const win = windows.get(pane.windowId)
    if (!win || win.isDestroyed()) return false
    showWindow(win)
    win.webContents.send('extensions:focus-pane', pane.paneId)
    return true
  }

  function showWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  return {
    settingsChanged,
    windowIds,
    workspaceWindowId,
    publishRemoteFolders,
    sendToWorkspaceWindow,
    broadcast,
    publishWorkspaceChips,
    publishInbox,
    focusPaneInWindow,
    primaryWindowId,
    showWindow,
    mainWindow,
    sendToWindow,
  }
}
