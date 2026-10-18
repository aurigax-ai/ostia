import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { registerControlMethod } from '../control/controlServer'
import { expandHome } from '../platform/pathGuard'

function realFolder(path: string, home: string): string | null {
  const expanded = expandHome(path, home)
  if (!isAbsolute(expanded)) return null
  try {
    return realpathSync(resolve(expanded))
  } catch {
    return resolve(expanded)
  }
}

export function isSameFolder(a: string, b: string, home: string): boolean {
  const left = realFolder(a, home)
  return left !== null && left === realFolder(b, home)
}

export interface SameFolderDeps {
  workDir: (workspaceId: string) => string | undefined
  home: () => string
}

export function registerSameFolder(deps: SameFolderDeps): void {
  registerControlMethod('workspace.sameFolder', {
    cap: 'read-board',
    handler: (raw, ctx) => {
      const dir = (raw as { dir?: unknown } | null)?.dir
      if (typeof dir !== 'string' || !isAbsolute(dir)) {
        return { ok: false, error: 'invalid-params', message: 'dir is an absolute path' }
      }
      const workspaceId = ctx.identity.workspaceId
      const workDir = workspaceId ? deps.workDir(workspaceId) : undefined
      const same = workDir !== undefined && isSameFolder(workDir, dir, deps.home())
      return { ok: true, same, ...(same ? { workspaceId } : {}) }
    },
  })
}
