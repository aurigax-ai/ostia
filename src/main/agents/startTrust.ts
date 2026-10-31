import { homedir } from 'node:os'
import type { PaneIdentity } from '../control/idRegistry'
import type { SettingsFile } from '../platform/settingsFile'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { carryTrust, outsideTrust, trustFolder } from './claudeFolderTrust'
import { workspaceFolder } from './extensionAgents'
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

export interface OutsideTrustDeps {
  scratchFolders: Pick<ScratchFolders, 'isScratch' | 'dirOf'>
  workspaceSandboxes: { isEnabled: (workspaceId: string) => boolean }
  readSettingsFile: () => SettingsFile
  claudeAccounts: { currentDirectory: () => string }
}

export function createOutsideTrust(
  deps: OutsideTrustDeps,
): (workspaceId: string, folder: string) => Promise<string | null> {
  return async (workspaceId, folder) => {
    if (deps.readSettingsFile().agents?.trustWorkspaceFolders !== true) return null
    if (deps.workspaceSandboxes.isEnabled(workspaceId)) return null
    const home = homedir()
    const scratch = deps.scratchFolders.isScratch(workspaceId)
    const workDir = scratch
      ? deps.scratchFolders.dirOf(workspaceId)
      : workspaceFolder(workDirForWorkspace(workspaceId), home)
    if (!workDir) return null
    const profileDir = scratch ? '' : deps.claudeAccounts.currentDirectory()
    return outsideTrust({
      folder,
      workDir,
      home,
      configDir: profileDir || process.env.CLAUDE_CONFIG_DIR || undefined,
      customOAuth: Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL),
    })
  }
}
