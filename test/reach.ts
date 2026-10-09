import { type Reach, createReach } from '../src/main/approvals/reach'
import { emptyWorkspaceSandbox } from '../src/shared/sandbox/sandbox'

export function ownWorkspaceReach(): Reach {
  return createReach({
    mode: () => 'workspace',
    home: '/nonexistent-home',
    workDir: () => undefined,
    isScratch: () => false,
    hasManager: () => false,
    sandbox: () => emptyWorkspaceSandbox(),
    workspaces: async () => ({ workspaces: [], groups: [] }),
    ask: () => null,
    agentGroupsChanged: () => {},
  })
}
