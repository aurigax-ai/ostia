import type { BrowserWindow } from 'electron'
import { postActionNotification } from '../attention/notify'
import type { NotifyDeps } from '../attention/notify'
import type { ExtensionHost } from '../extensions/extensionHost'
import { SANDBOX_FEATURE, installHint, missingRequirements } from '../platform/systemRequirements'
import { registerSecretMethods } from '../secrets/register'
import type { SecretService } from '../secrets/secretService'
import { deleteGlobalVaultValue, setGlobalVaultValue } from '../secrets/vault'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { registerSandboxMethods } from './controlMethods'
import type { DomainRequests } from './domainRequests'
import type { PortRequests } from './portRequests'
import { reportSandboxSpawnFailure } from './spawnFailureNotice'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

interface SandboxWiringDeps {
  domainRequests: DomainRequests
  portRequests: PortRequests
  secretService: SecretService
  workspaceSandboxes: WorkspaceSandboxes
  scanSandboxPorts: () => void
  PORT_SCAN_MS: number
  services: {
    extensionHost: ExtensionHost | null
    onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null
  }
  notifyDeps: NotifyDeps
  windows: Map<string, BrowserWindow>
}

export function registerSandboxWiring({
  domainRequests,
  portRequests,
  secretService,
  workspaceSandboxes,
  scanSandboxPorts,
  PORT_SCAN_MS,
  services,
  notifyDeps,
  windows,
}: SandboxWiringDeps) {
  registerSandboxMethods({ domains: domainRequests, ports: portRequests })
  registerSecretMethods({
    service: secretService,
    sandboxes: workspaceSandboxes,
    ownerWindow: windowForWorkspace,
    vaultSet: setGlobalVaultValue,
    vaultDelete: deleteGlobalVaultValue,
  })
  if (process.platform === 'linux') setInterval(scanSandboxPorts, PORT_SCAN_MS).unref()
  services.onSandboxSpawnFailure = (workspaceId, errors) =>
    reportSandboxSpawnFailure(
      {
        notify: (input, onClick) =>
          postActionNotification(notifyDeps, { ...input, from: 'sandbox' }, onClick),
        showRequirements: (id, report) => {
          const windowId = windowForWorkspace(id)
          const win = windowId ? windows.get(windowId) : undefined
          if (!win || win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          win.webContents.send('sandbox:blocked', { workspaceId: id, report })
        },
        report: () => {
          const missing = missingRequirements(SANDBOX_FEATURE)
          return {
            missing,
            hint: installHint(missing),
            canInstall:
              services.extensionHost?.list().some((x) => x.id === 'system' && x.enabled) ?? false,
          }
        },
      },
      workspaceId,
      errors,
    )
}
