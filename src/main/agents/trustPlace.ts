import { homedir, hostname } from 'node:os'
import { isHostNamed } from '../../shared/terminal/osc7'
import type { PaneIdentity } from '../control/idRegistry'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import type { TrustPlace } from './claudeFolderTrust'
import { workspaceFolder } from './extensionAgents'

export interface TrustPlaceDeps {
  ptys: Map<string, PtyEntry>
  scratchFolders: Pick<ScratchFolders, 'isScratch'>
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
}

export function trustPlaceOf(
  deps: TrustPlaceDeps,
  identity: Pick<PaneIdentity, 'paneId' | 'workspaceId' | 'manager'>,
  scratchDir: string | null = null,
): Omit<TrustPlace, 'configDir' | 'customOAuth'> | null {
  if (identity.manager) return null
  const { workspaceId } = identity
  if (deps.workspaceSandboxes.isEnabled(workspaceId)) return null
  if (deps.scratchFolders.isScratch(workspaceId) && !scratchDir) return null
  const home = homedir()
  const workDir = scratchDir ?? workspaceFolder(workDirForWorkspace(workspaceId), home)
  const report = deps.ptys.get(identity.paneId)?.mirror.cwdReport
  if (!workDir || !report || !isHostNamed(report.host, hostname())) return null
  return { folder: report.path, workDir, home }
}
