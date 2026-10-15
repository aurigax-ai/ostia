import { type BrowserWindow, ipcMain } from 'electron'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import type { ProcessTabRequest } from '../panes/processLaunch'
import { registerPane } from './idRegistry'

import type { OwnerLookup } from '../extensions/workspaceChips'

interface CommandBridgeDeps {
  commandsByWindow: Map<string, CommandDescriptor[]>
  terminalState: Map<string, TerminalStateSnapshot>
  windows: Map<string, BrowserWindow>
  mainWindow: () => BrowserWindow | undefined
  workspaceWindowId: OwnerLookup
}

export function createCommandBridge({
  commandsByWindow,
  terminalState,
  windows,
  mainWindow,
  workspaceWindowId,
}: CommandBridgeDeps) {
  function listCommandsFor(windowId: string): CommandDescriptor[] {
    return commandsByWindow.get(windowId) ?? []
  }

  function getTerminalState(paneId: string): TerminalStateSnapshot | undefined {
    return terminalState.get(paneId)
  }

  let reqSeq = 0

  function execCommand(
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain = false,
  ): Promise<CommandResult> {
    const win = target.windowId ? windows.get(target.windowId) : mainWindow()
    if (!win || win.isDestroyed()) {
      return Promise.resolve({
        ok: false,
        error: { code: 'command-failed', message: 'target window not available' },
      })
    }
    const reqId = `cmd-${++reqSeq}`
    return new Promise((resolve) => {
      const onResult = (_e: Electron.IpcMainEvent, rid: string, result: CommandResult): void => {
        if (rid !== reqId) return
        clearTimeout(timer)
        ipcMain.removeListener('command:result', onResult)
        resolve(result)
      }
      ipcMain.on('command:result', onResult)
      win.webContents.send('command:invoke', reqId, {
        id,
        args,
        target,
        ...(fromMain ? { fromMain: true } : {}),
      })
      const timer = setTimeout(() => {
        ipcMain.removeListener('command:result', onResult)
        resolve({ ok: false, error: { code: 'command-failed', message: 'command timed out' } })
      }, 5000)
    })
  }

  const OPEN_TERMINAL_TIMEOUT_MS = 5000
  let openTerminalSeq = 0

  function openTerminalInWindow(req: ProcessTabRequest): Promise<string | null> {
    const { windowId: requestedWindow, ...payload } = req
    const windowId =
      requestedWindow ?? (req.workspaceId ? workspaceWindowId(req.workspaceId) : undefined)
    const win = (windowId ? windows.get(windowId) : undefined) ?? mainWindow()
    if (!win || win.isDestroyed()) return Promise.resolve(null)
    const wid = String(win.webContents.id)
    const requestId = `term-${++openTerminalSeq}`
    return new Promise((resolve) => {
      const finish = (paneId: string | null): void => {
        clearTimeout(timer)
        ipcMain.removeListener('extensions:open-terminal-result', onResult)
        resolve(paneId)
      }
      const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
        if (rid !== requestId || String(e.sender.id) !== wid) return
        finish(
          typeof paneId === 'string' && paneId
            ? registerPane({ windowId: wid, workspaceId: req.workspaceId ?? '', paneId }).externalId
            : null,
        )
      }
      const timer = setTimeout(() => finish(null), OPEN_TERMINAL_TIMEOUT_MS)
      ipcMain.on('extensions:open-terminal-result', onResult)
      win.webContents.send('extensions:open-terminal', { ...payload, requestId })
    })
  }

  return { listCommandsFor, getTerminalState, execCommand, openTerminalInWindow }
}
