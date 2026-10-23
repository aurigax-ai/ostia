import { ipcMain } from 'electron'
import type { FolderTrust } from '../../shared/agents/agentsApi'
import { getByPaneId, panesOwnedBy } from '../control/idRegistry'
import type { SettingsFile } from '../platform/settingsFile'
import type { ClaudeAccounts } from './claudeAccounts/claudeAccounts'
import { folderTrust, type TrustPlace, trustFolder } from './claudeFolderTrust'
import { type TrustPlaceDeps, trustPlaceOf } from './trustPlace'

export interface FolderTrustIpcDeps extends TrustPlaceDeps {
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
  if (!identity || !panesOwnedBy([identity.paneId], senderId)) return null
  const place = trustPlaceOf(deps, identity)
  return (
    place && {
      ...place,
      configDir:
        deps.claudeAccounts.configDirFor(sessionId) ?? (process.env.CLAUDE_CONFIG_DIR || undefined),
      customOAuth: Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL),
    }
  )
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
