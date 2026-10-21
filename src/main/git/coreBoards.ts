import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { parseGitSettings } from '../../shared/boards/git'
import { parsePortsSettings } from '../../shared/boards/ports'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { CommandBridge } from '../control/commandBridge'
import { resolveExternal } from '../control/idRegistry'
import { listPanes, listWorkspaces } from '../panes/paneList'
import { readSettingsFile } from '../platform/settingsFile'
import { registerPortsIpc, registerPortsMethods } from '../ports/register'
import { PortsService } from '../ports/service'
import type { WindowSend } from '../windows/windowSend'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { GitCommands } from './commands'
import { confirmDiscard } from './confirmDiscard'
import { registerGitIpc, registerGitMethods } from './register'
import { GitService } from './service'
import { ViewStateStore } from './viewState'

interface CoreBoardsDeps {
  execCommand: CommandBridge['execCommand']
  getTerminalState: CommandBridge['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
  sendToWindow: WindowSend['sendToWindow']
  services: {
    gitService: GitService | null
    portsService: PortsService | null
  }
  mainStrings: () => Dict
  sendToWorkspaceWindow: WindowSend['sendToWorkspaceWindow']
  windows: Map<string, BrowserWindow>
  terminalState: Map<string, TerminalStateSnapshot>
  workspaceWindowId: WindowSend['workspaceWindowId']
}

export type CoreBoards = ReturnType<typeof createCoreBoards>

export function createCoreBoards({
  execCommand,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  sendToWindow,
  services,
  mainStrings,
  sendToWorkspaceWindow,
  windows,
  terminalState,
  workspaceWindowId,
}: CoreBoardsDeps) {
  function startCoreBoards(): void {
    const panes = () =>
      listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking })
    const service = new GitService({
      settings: () => parseGitSettings(readSettingsFile().git),
      listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
      listPanes: panes,
      send: sendToWindow,
      log: (line) => console.error(`[git] ${line}`),
    })
    services.gitService = service
    const commands = new GitCommands({
      settings: () => parseGitSettings(readSettingsFile().git),
      text: () => mainStrings().git,
      cwdOf: (workspaceId) => service.cwdOf(workspaceId),
      views: new ViewStateStore(join(app.getPath('userData'), 'git-view.json')),
      openDiff: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
      confirmDiscard: (prompt) => confirmDiscard(prompt, windows.values()),
      touched: () => service.touched(),
    })
    registerGitMethods({
      commands,
      callerOf: (identity) => ({
        workspaceId: identity.workspaceId,
        workDir: workDirForWorkspace(identity.workspaceId),
        cwd: terminalState.get(identity.paneId)?.cwd,
      }),
    })
    registerGitIpc({
      commands,
      service,
      ownerWindow: workspaceWindowId,
      workDirOf: workDirForWorkspace,
    })
    const ports = new PortsService({
      settings: () => parsePortsSettings(readSettingsFile().ports),
      listPanes: panes,
      rendererPaneId: (externalId) => resolveExternal(externalId)?.paneId,
      send: sendToWindow,
      log: (line) => console.error(`[ports] ${line}`),
    })
    services.portsService = ports
    registerPortsMethods(ports)
    registerPortsIpc(ports)
  }

  return { startCoreBoards }
}
