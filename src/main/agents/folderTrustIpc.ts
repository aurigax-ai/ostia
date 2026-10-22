import { homedir, hostname } from 'node:os'
import { ipcMain } from 'electron'
import type { FolderTrust } from '../../shared/agents/agentsApi'
import { isHostNamed } from '../../shared/terminal/osc7'
import { getByPaneId, panesOwnedBy } from '../control/idRegistry'
import type { SettingsFile } from '../platform/settingsFile'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import type { ClaudeAccounts } from './claudeAccounts/claudeAccounts'
import { folderTrust, type TrustPlace, trustFolder } from './claudeFolderTrust'
import { workspaceFolder } from './extensionAgents'

export interface FolderTrustIpcDeps {
  ptys: Map<string, PtyEntry>
  scratchFolders: Pick<ScratchFolders, 'isScratch'>
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
  readSettingsFile: () => SettingsFile
  claudeAccounts: Pick<ClaudeAccounts, 'configDirFor'>
}

function placeOf(
  deps: FolderTrustIpcDeps,
  senderId: string,
  paneId: unknown,
  sessionId: string | null,
): TrustPlace | null {
  const identity = typeof paneId === 'string' ? getByPaneId(paneId) : undefined
  if (!identity || identity.manager || !panesOwnedBy([identity.paneId], senderId)) return null
  const { workspaceId } = identity
  if (deps.scratchFolders.isScratch(workspaceId) || deps.workspaceSandboxes.isEnabled(workspaceId))
    return null
  const home = homedir()
  const workDir = workspaceFolder(workDirForWorkspace(workspaceId), home)
  const report = deps.ptys.get(identity.paneId)?.mirror.cwdReport
  if (!workDir || !report || !isHostNamed(report.host, hostname())) return null
  return {
    folder: report.path,
    workDir,
    home,
    configDir:
      deps.claudeAccounts.configDirFor(sessionId) ?? (process.env.CLAUDE_CONFIG_DIR || undefined),
    customOAuth: Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL),
  }
}

export function registerFolderTrustIpc(deps: FolderTrustIpcDeps): void {
  const askedFor = new Map<string, string | null>()
  const remember = (paneId: unknown, session: string | null): void => {
    for (const id of askedFor.keys()) if (!getByPaneId(id)) askedFor.delete(id)
    if (typeof paneId === 'string') askedFor.set(paneId, session)
  }

  ipcMain.handle(
    'agent:folder-trust',
    async (e, paneId: unknown, sessionId?: unknown): Promise<FolderTrust> => {
      const session = typeof sessionId === 'string' ? sessionId : null
      const place = placeOf(deps, String(e.sender.id), paneId, session)
      if (!place) return { state: 'unknown' }
      remember(paneId, session)
      const verdict = await folderTrust(place)
      if (verdict.state !== 'ask' || deps.readSettingsFile().agents?.trustWorkspaceFolders !== true)
        return verdict
      return (await trustFolder(place)) ? { state: 'trusted' } : verdict
    },
  )

  ipcMain.handle(
    'agent:trust-folder',
    async (e, paneId: unknown, shown: unknown): Promise<boolean> => {
      const session = (typeof paneId === 'string' && askedFor.get(paneId)) || null
      const place = placeOf(deps, String(e.sender.id), paneId, session)
      return place && typeof shown === 'string' ? trustFolder(place, shown) : false
    },
  )
}
