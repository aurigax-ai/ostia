import type { BrowserWindow } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { fmt } from '../../shared/app/dict'
import type { Reach, ReachListing } from '../approvals/reach'
import { setUserPresenceCheck } from '../approvals/scriptTokenConfirm'
import { registerScriptTokenIpc } from '../approvals/scriptTokenIpc'
import { checkScriptToken, registerScriptTokenMethods } from '../approvals/scriptTokens'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import { electronPresenceDeps, verifyUserPresence } from '../approvals/userPresence'
import type { AgentJournal } from '../diagnostics/agentJournal'
import type { IncidentTimeline } from '../diagnostics/incidentTimeline'
import type { ExtensionHost } from '../extensions/extensionHost'
import { extensionCommandRunner } from '../extensions/extensionMethods'
import { listPanes } from '../panes/paneList'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { KeptShellsWiring } from '../tmux/keptShellsWiring'
import { runningBuild } from '../updates/appVersion'
import type { WindowSend } from '../windows/windowSend'
import type { CommandBridge } from './commandBridge'
import { setScriptTokenCheck } from './controlAuth'
import { controlInfoPath, writeControlInfo } from './controlDiscovery'
import { controlSocketPath, registerControlServer, sweepStaleControlSockets } from './controlServer'

interface ControlStartDeps {
  mainStrings: () => Dict
  scriptTokensPath: () => string
  workspaceListing: () => Promise<ReachListing>
  broadcast: WindowSend['broadcast']
  windows: Map<string, BrowserWindow>
  scriptTokenUsage: ScriptTokenUsageLog
  execCommand: CommandBridge['execCommand']
  getTerminalState: CommandBridge['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
  listCommandsFor: CommandBridge['listCommandsFor']
  workspaceSandboxes: WorkspaceSandboxes
  workspaceWindowId: WindowSend['workspaceWindowId']
  primaryWindowId: WindowSend['primaryWindowId']
  reach: Reach
  keptPlumbing: KeptShellsWiring['keptPlumbing']
  keepShellsOn: KeptShellsWiring['keepShellsOn']
  services: {
    agentJournal: AgentJournal | null
    incidents: IncidentTimeline | null
    extensionHost: ExtensionHost | null
  }
}

export function startControlServer({
  mainStrings,
  scriptTokensPath,
  workspaceListing,
  broadcast,
  windows,
  scriptTokenUsage,
  execCommand,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  listCommandsFor,
  workspaceSandboxes,
  workspaceWindowId,
  primaryWindowId,
  reach,
  keptPlumbing,
  keepShellsOn,
  services,
}: ControlStartDeps) {
  const scriptTokenDeps = {
    path: scriptTokensPath,
    listing: workspaceListing,
    changed: () => broadcast('scriptTokens:changed', null),
    appWindows: () => windows.values(),
    usage: scriptTokenUsage,
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
  }
  registerScriptTokenMethods(scriptTokenDeps)
  registerScriptTokenIpc(scriptTokenDeps)
  setScriptTokenCheck((token) => checkScriptToken({ path: scriptTokensPath() }, token))
  const presenceDeps = electronPresenceDeps(
    () => windows.values(),
    () => mainStrings().native.userPresence,
    process.resourcesPath,
  )
  setUserPresenceCheck(({ action, name }) =>
    verifyUserPresence(
      { reason: fmt(mainStrings().native.userPresence[action], { name }), name },
      presenceDeps,
    ),
  )
  registerControlServer({
    execCommand,
    extensionCommand: extensionCommandRunner(() => services.extensionHost),
    listCommandsFor,
    getTerminalState,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    windowOfWorkspace: workspaceWindowId,
    primaryWindow: primaryWindowId,
    byAgent: reach.byAgent,
    reach,
    usage: scriptTokenUsage,
    journal: services.agentJournal ?? undefined,
    incidents: services.incidents ?? undefined,
    version: () => runningBuild()?.version ?? null,
  })
  sweepStaleControlSockets()
  writeControlInfo(controlInfoPath(), controlSocketPath(), process.pid)
  keptPlumbing.start(keepShellsOn())
}
