import { homedir } from 'node:os'
import type {
  ExtensionEventPayloads,
  ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { ipcMain } from 'electron'
import { approvals } from '../approvals/approvals'
import { loadReachMode } from '../approvals/capabilityStore'
import { createReach, type ReachListing } from '../approvals/reach'
import {
  listScriptTokens,
  recordCreatedWorkspace,
  scriptTokenScope,
} from '../approvals/scriptTokens'
import { createScriptTokenUsage } from '../approvals/scriptTokenUsage'
import { workspaceHasManager } from '../control/idRegistry'
import { listWorkspaceGroups, listWorkspaces } from '../panes/paneList'
import { storePath } from '../platform/jsonStore'
import { createWorkspaceLifecycle } from '../workspaces/workspaceLifecycle'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'
import type { BrowserContext } from './browserServices'

export function createWorkspaceServices(ctx: BrowserContext) {
  const {
    artifactFolders,
    artifactHistory,
    artifactProducers,
    broadcast,
    domainRequests,
    execCommand,
    openWaits,
    packageRequests,
    portForwarder,
    portRequests,
    ptys,
    sandboxViolations,
    scratchFolders,
    secretService,
    services,
    windowIds,
    workspaceAgents,
    workspaceSandboxes,
  } = ctx

  const managerResumePath = (): string => storePath('manager-resume', 'global')
  const scriptTokensPath = (): string => storePath('script-tokens-v2', 'global')
  const scriptTokenUsage = createScriptTokenUsage(() => storePath('script-token-usage', 'global'), {
    known: () => new Set(listScriptTokens(scriptTokensPath()).map((t) => t.id)),
  })

  async function workspaceListing(): Promise<ReachListing> {
    const [workspaces, groups] = await Promise.all([
      listWorkspaces({ execCommand, windowIds }),
      listWorkspaceGroups({ execCommand, windowIds }),
    ])
    return { workspaces, groups }
  }

  const reach = createReach({
    mode: loadReachMode,
    home: homedir(),
    workDir: (workspaceId) => workDirForWorkspace(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    hasManager: (workspaceId) => workspaceHasManager(workspaceId),
    sandbox: (workspaceId) => ({
      ...workspaceSandboxes.settings(workspaceId),
      enabled: workspaceSandboxes.isEnabled(workspaceId),
    }),
    workspaces: workspaceListing,
    ask: (ask) => approvals()?.request(ask) ?? null,
    agentGroupsChanged: (placements) => broadcast('reach:agent-groups-changed', placements),
    scriptScope: (tokenId) => scriptTokenScope(scriptTokensPath(), tokenId),
    scriptCreated: (tokenId, workspaceId) =>
      recordCreatedWorkspace(scriptTokensPath(), tokenId, workspaceId),
  })
  ipcMain.handle('reach:agent-groups', () => reach.agentGroups())

  const { workspaceClosed, releaseMergedSandbox, registerWorkspaceIpc } = createWorkspaceLifecycle({
    openWaits,
    reach,
    services,
    artifactHistory,
    artifactFolders,
    scratchFolders,
    packageRequests,
    portForwarder,
    portRequests,
    domainRequests,
    workspaceSandboxes,
    sandboxViolations,
    workspaceAgents,
    secretService,
    ptys,
    emitPaneEvent,
    artifactProducers,
  })

  function emitPaneEvent<T extends ExtensionEventType>(
    type: T,
    payload: ExtensionEventPayloads[T],
  ): void {
    services.extensionHost?.events.emitEvent(type, payload)
    services.gitService?.activity(type)
    services.portsService?.activity(type)
  }

  return {
    managerResumePath,
    scriptTokensPath,
    scriptTokenUsage,
    workspaceListing,
    reach,
    workspaceClosed,
    releaseMergedSandbox,
    registerWorkspaceIpc,
    emitPaneEvent,
  }
}

export type WorkspaceContext = BrowserContext & ReturnType<typeof createWorkspaceServices>
