import type { BrowserWindow } from 'electron'
import { fmt } from '../../shared/app/dict'
import type { Dict } from '../../shared/app/dict'
import type { ReachListing } from '../approvals/reach'
import type { Reach } from '../approvals/reach'
import { setUserPresenceCheck } from '../approvals/scriptTokenConfirm'
import { registerScriptTokenIpc } from '../approvals/scriptTokenIpc'
import { retireLegacyScriptTokens } from '../approvals/scriptTokenRetired'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import { checkScriptToken, registerScriptTokenMethods } from '../approvals/scriptTokens'
import { electronPresenceDeps, verifyUserPresence } from '../approvals/userPresence'
import { postNotification } from '../attention/notify'
import type { NotifyWiring } from '../attention/notifyWiring'
import { listPanes } from '../panes/paneList'
import { storePath } from '../platform/jsonStore'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { KeptShellsWiring } from '../tmux/keptShellsWiring'
import type { WindowSend } from '../windows/windowSend'
import type { CommandBridge } from './commandBridge'
import { setScriptTokenCheck } from './controlAuth'
import { controlInfoPath, writeControlInfo } from './controlDiscovery'
import { controlSocketPath, registerControlServer } from './controlServer'

interface ControlStartDeps {
  retiredScriptTokensPath: () => string
  mainStrings: () => Dict
  notifyDeps: NotifyWiring['notifyDeps']
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
}

export function startControlServer({
  retiredScriptTokensPath,
  mainStrings,
  notifyDeps,
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
}: ControlStartDeps) {
  const retiredTokens = retireLegacyScriptTokens(
    storePath('script-tokens', 'global'),
    retiredScriptTokensPath(),
  )
  if (retiredTokens.length > 0) {
    const text = mainStrings().native.scriptTokensRetired
    postNotification(notifyDeps, {
      title: fmt(text.title, { count: retiredTokens.length }),
      body: fmt(text.body, { names: retiredTokens.join(', ') }),
      from: 'script-tokens',
    })
  }
  const scriptTokenDeps = {
    path: scriptTokensPath,
    retiredPath: retiredScriptTokensPath,
    listing: workspaceListing,
    changed: () => broadcast('scriptTokens:changed', null),
    appWindows: () => windows.values(),
    usage: scriptTokenUsage,
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
  }
  registerScriptTokenMethods(scriptTokenDeps)
  registerScriptTokenIpc(scriptTokenDeps)
  setScriptTokenCheck((token) =>
    checkScriptToken({ path: scriptTokensPath(), retiredPath: retiredScriptTokensPath() }, token),
  )
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
    listCommandsFor,
    getTerminalState,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    windowOfWorkspace: workspaceWindowId,
    primaryWindow: primaryWindowId,
    byAgent: reach.byAgent,
    reach,
    usage: scriptTokenUsage,
  })
  writeControlInfo(controlInfoPath(), controlSocketPath(), process.pid)
  keptPlumbing.start(keepShellsOn())
}
