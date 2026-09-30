import { ipcMain } from 'electron'
import type { ExtensionCaller, ExtensionResult } from '../shared/extensions'
import type { MissingRequirement, RequirementsReport } from '../shared/systemRequirements'
import { installHint } from './systemRequirements'

export interface SystemRequirementsIpcDeps {
  ownerWindow: (workspaceId: string) => string | undefined
  workDir: (workspaceId: string) => string | undefined
  locale: () => string | undefined
  systemExtensionEnabled: () => boolean
  missing: (feature: string) => MissingRequirement[]
  invokeInstall: (args: { argv: string[] }, caller: ExtensionCaller) => Promise<ExtensionResult>
}

export function requirementsInstallArgs(
  feature: string,
  missing: MissingRequirement[],
): { argv: string[] } {
  const packages = [...new Set(missing.map((m) => m.package))]
  return { argv: [...packages, '--reason', `Pine's ${feature} feature needs them`] }
}

export function registerSystemRequirementsIpc(deps: SystemRequirementsIpcDeps): void {
  ipcMain.handle('system:requirements', (_e, feature: unknown): RequirementsReport | null => {
    if (typeof feature !== 'string') return null
    const missing = deps.missing(feature)
    return {
      missing,
      hint: installHint(missing),
      canInstall: missing.length > 0 && deps.systemExtensionEnabled(),
    }
  })

  ipcMain.handle(
    'system:install-requirements',
    async (e, feature: unknown, workspaceId: unknown): Promise<ExtensionResult> => {
      if (
        typeof feature !== 'string' ||
        typeof workspaceId !== 'string' ||
        deps.ownerWindow(workspaceId) !== String(e.sender.id)
      ) {
        return { ok: false, error: 'not-allowed' }
      }
      const missing = deps.missing(feature)
      if (missing.length === 0) return { ok: true }
      const workDir = deps.workDir(workspaceId)
      return deps.invokeInstall(requirementsInstallArgs(feature, missing), {
        kind: 'user',
        workspaceId,
        ...(workDir ? { workDir, cwd: workDir } : {}),
        locale: deps.locale(),
        capabilities: ['shell'],
      })
    },
  )
}
