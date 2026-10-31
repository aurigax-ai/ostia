import type { PaneIdentity } from '../control/idRegistry'
import type { SettingsFile } from '../platform/settingsFile'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { carryTrust, trustFolder } from './claudeFolderTrust'
import { type TrustPlaceDeps, trustPlaceOf } from './trustPlace'

export interface StartTrustDeps extends TrustPlaceDeps {
  scratchFolders: Pick<ScratchFolders, 'isScratch' | 'dirOf'>
  readSettingsFile: () => SettingsFile
}

export function createStartTrust(
  deps: StartTrustDeps,
): (profileDir: string, identity: PaneIdentity) => Promise<boolean> {
  return async (profileDir, identity) => {
    const place = trustPlaceOf(deps, identity, deps.scratchFolders.dirOf(identity.workspaceId))
    if (!place) return false
    const defaultConfigDir = process.env.CLAUDE_CONFIG_DIR || undefined
    const customOAuth = Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL)
    if (deps.readSettingsFile().agents?.trustWorkspaceFolders === true)
      return trustFolder({ ...place, configDir: profileDir || defaultConfigDir, customOAuth })
    return profileDir
      ? carryTrust({ ...place, configDir: profileDir, customOAuth }, defaultConfigDir)
      : false
  }
}
