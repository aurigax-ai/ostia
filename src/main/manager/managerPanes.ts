import { tmpdir } from 'node:os'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { app, type BrowserWindow, ipcMain } from 'electron'
import { MANAGER_FEATURE } from '../../shared/agents/managerSettings'
import { portalSocketPath } from '../../shared/agents/portal'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import type { Reach } from '../approvals/reach'
import type { CommandBridge } from '../control/commandBridge'
import { installHint, missingRequirements } from '../platform/systemRequirements'
import type { PtyIo } from '../terminal/pty/ptyIo'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { WindowSend } from '../windows/windowSend'
import { type ManagerService, managerWindowId } from './manager'
import { Portal, type PortalDeps, portalSupported } from './portal'
import { callerVerdict, procFs, ttysOf } from './portalCaller'

interface ManagerPanesDeps {
  primaryWindowId: WindowSend['primaryWindowId']
  windows: Map<string, BrowserWindow>
  reach: Reach
  execCommand: CommandBridge['execCommand']
  openTerminalInWindow: CommandBridge['openTerminalInWindow']
  services: {
    managerService: ManagerService | null
    portal: Portal | null
  }
  ptys: Map<string, PtyEntry>
  attachMirror: PtyIo['attachMirror']
  attachSession: PortalDeps['attachSession']
}

export type ManagerPanes = ReturnType<typeof createManagerPanes>

export function createManagerPanes({
  primaryWindowId,
  windows,
  reach,
  execCommand,
  openTerminalInWindow,
  services,
  ptys,
  attachMirror,
  attachSession,
}: ManagerPanesDeps) {
  const MANAGER_READY_TIMEOUT_MS = 20_000
  const MANAGER_OPEN_TIMEOUT_MS = 5000
  const managerReadyWindows = new Set<string>()
  const managerReadyWaiters = new Set<() => void>()
  let managerOpenSeq = 0

  function registerManagerIpc(): void {
    ipcMain.on('manager:ready', (e) => {
      managerReadyWindows.add(String(e.sender.id))
      for (const wake of managerReadyWaiters) wake()
      managerReadyWaiters.clear()
    })
  }

  function managerWindow(): Promise<BrowserWindow | null> {
    const ready = (): BrowserWindow | null => {
      const id = managerWindowId(primaryWindowId(), managerReadyWindows)
      const win = id ? windows.get(id) : undefined
      return win && !win.isDestroyed() ? win : null
    }
    const now = ready()
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        managerReadyWaiters.delete(wake)
        resolve(ready())
      }
      const timer = setTimeout(wake, MANAGER_READY_TIMEOUT_MS)
      managerReadyWaiters.add(wake)
    })
  }

  async function createManagerPane(req: {
    agent: string
    cwd: string
    session: boolean
  }): Promise<string | null> {
    const win = await managerWindow()
    if (!win) return null
    const wid = String(win.webContents.id)
    const requestId = `manager-${++managerOpenSeq}`
    return new Promise((resolve) => {
      const finish = (paneId: string | null): void => {
        clearTimeout(timer)
        ipcMain.removeListener('manager:open-result', onResult)
        resolve(paneId)
      }
      const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
        if (rid !== requestId || String(e.sender.id) !== wid) return
        finish(typeof paneId === 'string' && paneId ? paneId : null)
      }
      const timer = setTimeout(() => finish(null), MANAGER_OPEN_TIMEOUT_MS)
      ipcMain.on('manager:open-result', onResult)
      win.webContents.send('manager:open', requestId, req)
    })
  }

  async function openWorker(req: {
    argv: string[]
    cwd?: string
    workspaceId?: string
    name?: string
  }): Promise<string | null> {
    let workspaceId = req.workspaceId
    if (!workspaceId) {
      const created = await reach.byAgent(() =>
        execCommand({ workspaceId: '', paneId: null }, 'workspace.new', {
          ...(req.cwd ? { dir: req.cwd } : {}),
          ...(req.name ? { name: req.name } : {}),
        }),
      )
      const result = created.ok ? (created.result as { workspaceId?: unknown }) : undefined
      if (typeof result?.workspaceId !== 'string') return null
      workspaceId = result.workspaceId
    }
    return openTerminalInWindow({
      command: quoteArgv(req.argv),
      workspaceId,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      title: req.argv[0],
    })
  }

  function startPortal(): void {
    if (!services.managerService || !portalSupported(process.platform)) return
    const service = services.managerService
    services.portal = new Portal(portalSocketPath(app.isPackaged, process.env, tmpdir()), {
      missing: () => missingRequirements(MANAGER_FEATURE),
      hint: (missing) => installHint(missing),
      judge: (socket) =>
        callerVerdict(socket, {
          mainPid: process.pid,
          paneTtys: ttysOf(
            [...ptys.values()].map((entry) => entry.pty.pid),
            procFs,
          ),
          proc: procFs,
        }),
      manager: service,
      attachMirror,
      attachSession,
    })
    services.portal
      .start()
      .then((started) => {
        if (!started)
          console.warn(`[portal] another ${PRODUCT_DISPLAY_NAME} owns the portal socket`)
      })
      .catch((err) => console.error('[portal] failed to start', err))
  }

  return { registerManagerIpc, createManagerPane, openWorker, startPortal }
}
