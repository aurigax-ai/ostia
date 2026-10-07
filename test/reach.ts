import { type Reach, createReach } from '../src/main/reach'
import { emptyWorkspaceSandbox } from '../src/shared/sandbox'

export function ownWorkspaceReach(): Reach {
  return createReach({
    mode: () => 'workspace',
    home: '/nonexistent-home',
    workDir: () => undefined,
    isScratch: () => false,
    hasManager: () => false,
    sandbox: () => emptyWorkspaceSandbox(),
    groups: async () => ({ workspaces: [], groups: [] }),
    ask: () => null,
  })
}
