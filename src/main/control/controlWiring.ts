import type { BrowserWindow } from 'electron'
import { fmt } from '../../shared/app/dict'
import type { Dict } from '../../shared/app/dict'
import type { CommandDescriptor, CommandTarget, TerminalStateSnapshot } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import type { ReachListing } from '../approvals/reach'
import type { Reach } from '../approvals/reach'
import { registerScriptTokenIpc } from '../approvals/scriptTokenIpc'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import {
  checkScriptToken,
  registerScriptTokenMethods,
  retireLegacyScriptTokens,
  setUserPresenceCheck,
} from '../approvals/scriptTokens'
import { electronPresenceDeps, verifyUserPresence } from '../approvals/userPresence'
import { postNotification } from '../attention/notify'
import type { OwnerLookup } from '../extensions/workspaceChips'
import { listPanes } from '../panes/paneList'
import { storePath } from '../platform/jsonStore'
import type { RedactText } from '../privacy/redactionTargets'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { KeptPlumbing } from '../tmux/keptLaunchers'
import { setScriptTokenCheck } from './controlAuth'
import { controlInfoPath, writeControlInfo } from './controlDiscovery'
import { controlSocketPath, registerControlServer } from './controlServer'

interface ControlStartDeps {
  retiredScriptTokensPath: () => string
  mainStrings: () => Dict
  notifyDeps: {
    execCommand: (
      target: CommandTarget,
      id: string,
      args?: unknown,
      fromMain?: boolean,
    ) => Promise<CommandResult>
    isScratchPane: (paneId: string) => boolean
    windows: () => MapIterator<BrowserWindow>
    windowById: (id: string) => BrowserWindow | undefined
    redact: RedactText
  }
  scriptTokensPath: () => string
  workspaceListing: () => Promise<ReachListing>
  broadcast: (channel: string, payload: unknown) => void
  windows: Map<string, BrowserWindow>
  scriptTokenUsage: ScriptTokenUsageLog
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
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  workspaceSandboxes: WorkspaceSandboxes
  workspaceWindowId: OwnerLookup
  primaryWindowId: () => string | undefined
  reach: Reach
  keptPlumbing: KeptPlumbing
  keepShellsOn: () => boolean
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
