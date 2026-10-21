import type { OpenWaits } from './openWaits'

type WorkspaceStep = (workspaceId: string) => void

export interface WorkspaceClosedDeps {
  openWaits: Pick<OpenWaits, 'workspaceClosed'>
  removeWorkspace: WorkspaceStep
  forgetReach: WorkspaceStep
  closeProcesses: WorkspaceStep
  forgetNames: WorkspaceStep
  clearChips: WorkspaceStep
  closeRemoteFolders: WorkspaceStep
  tellExtensions: WorkspaceStep
  closeArtifacts: WorkspaceStep
  removeScratch: WorkspaceStep
  forgetRequests: WorkspaceStep
  forgetSandbox: WorkspaceStep
}

export function createWorkspaceClosed(deps: WorkspaceClosedDeps): WorkspaceStep {
  return (workspaceId) => {
    deps.removeWorkspace(workspaceId)
    deps.forgetReach(workspaceId)
    deps.closeProcesses(workspaceId)
    deps.forgetNames(workspaceId)
    deps.clearChips(workspaceId)
    deps.closeRemoteFolders(workspaceId)
    deps.tellExtensions(workspaceId)
    deps.openWaits.workspaceClosed(workspaceId)
    deps.closeArtifacts(workspaceId)
    deps.removeScratch(workspaceId)
    deps.forgetRequests(workspaceId)
    deps.forgetSandbox(workspaceId)
  }
}
