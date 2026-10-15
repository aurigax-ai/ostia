import { join } from 'node:path'
import { type BrowserWindow, app } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { parseGitSettings } from '../../shared/boards/git'
import { parsePortsSettings } from '../../shared/boards/ports'
import type { CommandTarget, TerminalStateSnapshot } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import { resolveExternal } from '../control/idRegistry'
import type { OwnerLookup } from '../extensions/workspaceChips'
import { listPanes, listWorkspaces } from '../panes/paneList'
import { readSettingsFile } from '../platform/settingsFile'
import { registerPortsIpc, registerPortsMethods } from '../ports/register'
import { PortsService } from '../ports/service'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { GitCommands } from './commands'
import { confirmDiscard } from './confirmDiscard'
import { registerGitIpc, registerGitMethods } from './register'
import { GitService } from './service'
import { ViewStateStore } from './viewState'

interface CoreBoardsDeps {
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  ptyPid: (paneId: string) => number | undefined
  windowIds: () => string[]
  isWaking: (paneId: string) => boolean
  sendToWindow: (windowId: string, channel: string, payload: unknown) => void
  services: {
    gitService: GitService | null
    portsService: PortsService | null
  }
  mainStrings: () => Dict
  sendToWorkspaceWindow: (
    workspaceId: string | undefined,
    channel: string,
    payload: unknown,
  ) => void
  windows: Map<string, BrowserWindow>
  terminalState: Map<string, TerminalStateSnapshot>
  workspaceWindowId: OwnerLookup
}

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
