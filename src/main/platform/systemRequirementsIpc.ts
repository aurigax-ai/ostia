import type {
  ExtensionCaller,
  ExtensionResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { ipcMain } from 'electron'
import type { MissingRequirement, RequirementsReport } from '../../shared/app/systemRequirements'
import { installHint } from './systemRequirements'

export interface SystemRequirementsIpcDeps {
  ownerWindow: (workspaceId: string) => string | undefined
  workDir: (workspaceId: string) => string | undefined
  locale: () => string | undefined
  systemExtensionEnabled: () => boolean
  missing: (feature: string) => MissingRequirement[]
  settled?: () => Promise<void>
  label?: (feature: string) => string
  invokeInstall: (args: { argv: string[] }, caller: ExtensionCaller) => Promise<ExtensionResult>
}

export function requirementsInstallArgs(
  feature: string,
  missing: MissingRequirement[],
): { argv: string[] } {
  const packages = [...new Set(missing.map((m) => m.package))]
  return {
    argv: [
      ...packages,
      '--reason',
      `${PRODUCT_DISPLAY_NAME}'s ${feature} feature needs them`,
      '--wait',
    ],
  }
}

export function registerSystemRequirementsIpc(deps: SystemRequirementsIpcDeps): void {
  ipcMain.handle(
    'system:requirements',
    async (_e, feature: unknown): Promise<RequirementsReport | null> => {
      if (typeof feature !== 'string') return null
      await deps.settled?.()
      const missing = deps.missing(feature)
      return {
        missing,
        hint: installHint(missing),
        canInstall: missing.length > 0 && deps.systemExtensionEnabled(),
      }
    },
  )

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
      return deps.invokeInstall(
        requirementsInstallArgs(deps.label?.(feature) ?? feature, missing),
        {
          kind: 'user',
          workspaceId,
          ...(workDir ? { workDir, cwd: workDir } : {}),
          locale: deps.locale(),
          capabilities: ['shell'],
        },
      )
    },
  )
}
