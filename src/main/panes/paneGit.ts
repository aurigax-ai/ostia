import { readStatus, repoRoot } from '../git/repo'
import type { PaneStatusDeps } from './paneStatus'

interface PaneGitDeps {
  isRemote: (paneId: string) => boolean
  isSandboxed: (paneId: string) => boolean
}

export function paneGit({ isRemote, isSandboxed }: PaneGitDeps): PaneStatusDeps['git'] {
  return async (paneId, cwd) => {
    if (!cwd || isRemote(paneId) || isSandboxed(paneId)) return undefined
    try {
      const root = await repoRoot(cwd)
      if (!root) return undefined
      const { branch, changes } = await readStatus(root)
      return {
        branch: branch.head,
        ahead: branch.ahead,
        behind: branch.behind,
        changed: changes.length,
      }
    } catch {
      return undefined
    }
  }
}
