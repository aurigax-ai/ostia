import { ipcMain } from 'electron'
import type { FolderTrust } from '../../shared/agents/agentsApi'
import { getByPaneId, panesOwnedBy } from '../control/idRegistry'
import type { SettingsFile } from '../platform/settingsFile'
import type { ClaudeAccounts } from './claudeAccounts/claudeAccounts'
import { folderTrust, type TrustPlace, trustFolder } from './claudeFolderTrust'
import { type TrustPlaceDeps, trustPlaceOf } from './trustPlace'

export interface FolderTrustIpcDeps extends TrustPlaceDeps {
  readSettingsFile: () => SettingsFile
  claudeAccounts: Pick<ClaudeAccounts, 'configDir'>
}

function placeOf(deps: FolderTrustIpcDeps, senderId: string, paneId: unknown): TrustPlace | null {
  const identity = typeof paneId === 'string' ? getByPaneId(paneId) : undefined
  if (!identity || !panesOwnedBy([identity.paneId], senderId)) return null
  const place = trustPlaceOf(deps, identity)
  return (
    place && {
      ...place,
      configDir: deps.claudeAccounts.configDir() ?? (process.env.CLAUDE_CONFIG_DIR || undefined),
      customOAuth: Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL),
    }
  )
}

export function registerFolderTrustIpc(deps: FolderTrustIpcDeps): void {
  ipcMain.handle('agent:folder-trust', async (e, paneId: unknown): Promise<FolderTrust> => {
    const place = placeOf(deps, String(e.sender.id), paneId)
    if (!place) return { state: 'unknown' }
    const verdict = await folderTrust(place)
    if (verdict.state !== 'ask' || deps.readSettingsFile().agents?.trustWorkspaceFolders !== true)
      return verdict
    return (await trustFolder(place)) ? { state: 'trusted' } : verdict
  })

  ipcMain.handle('agent:trust-folder', async (e, paneId: unknown, shown: unknown) => {
    const place = placeOf(deps, String(e.sender.id), paneId)
    return place && typeof shown === 'string' ? trustFolder(place, shown) : false
  })
}
