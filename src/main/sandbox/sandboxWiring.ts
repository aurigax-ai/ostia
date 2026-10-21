import type { BrowserWindow } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { postActionNotification } from '../attention/notify'
import type { NotifyWiring } from '../attention/notifyWiring'
import type { ExtensionHost } from '../extensions/extensionHost'
import { readLocale } from '../platform/settingsFile'
import {
  installHint,
  missingRequirements,
  requirementLabel,
  SANDBOX_FEATURE,
} from '../platform/systemRequirements'
import { registerSystemRequirementsIpc } from '../platform/systemRequirementsIpc'
import { loginPathSettled } from '../platform/toolPath'
import { registerSecretMethods } from '../secrets/register'
import type { SecretService } from '../secrets/secretService'
import { deleteGlobalVaultValue, setGlobalVaultValue } from '../secrets/vault'
import { windowForWorkspace, workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { registerSandboxMethods } from './controlMethods'
import type { DomainRequests } from './domainRequests'
import { registerSandboxIpc } from './ipc'
import type { PortRequests } from './ports/portRequests'
import { reportSandboxSpawnFailure } from './spawnFailureNotice'
import type { ViolationLog } from './violations'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

const PORT_SCAN_MS = 3000

function systemExtensionEnabled(extensionHost: ExtensionHost | null): boolean {
  return extensionHost?.list().some((ext) => ext.id === 'system' && ext.enabled) ?? false
}

interface SandboxWiringDeps {
  mainStrings: () => Dict
  domainRequests: DomainRequests
  portRequests: PortRequests
  secretService: SecretService
  workspaceSandboxes: WorkspaceSandboxes
  scanSandboxPorts: () => void
  services: {
    extensionHost: ExtensionHost | null
    onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null
  }
  notifyDeps: NotifyWiring['notifyDeps']
  windows: Map<string, BrowserWindow>
}

export function registerSandboxWiring({
  mainStrings,
  domainRequests,
  portRequests,
  secretService,
  workspaceSandboxes,
  scanSandboxPorts,
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
        text: () => mainStrings().native.sandboxSoftware,
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
            canInstall: systemExtensionEnabled(services.extensionHost),
          }
        },
      },
      workspaceId,
      errors,
    )
}

interface SandboxIpcWiringDeps {
  workspaceSandboxes: WorkspaceSandboxes
  domainRequests: DomainRequests
  portRequests: PortRequests
  sandboxViolations: ViolationLog
  services: {
    extensionHost: ExtensionHost | null
  }
}

export function registerSandboxIpcWiring({
  workspaceSandboxes,
  domainRequests,
  portRequests,
  sandboxViolations,
  services,
}: SandboxIpcWiringDeps) {
  registerSandboxIpc({
    sandboxes: workspaceSandboxes,
    ownerWindow: windowForWorkspace,
    missing: () => missingRequirements(SANDBOX_FEATURE),
    domains: domainRequests,
    ports: portRequests,
    violations: sandboxViolations,
    refreshAll: () => workspaceSandboxes.hosts.refreshAll(),
  })
  registerSystemRequirementsIpc({
    ownerWindow: windowForWorkspace,
    workDir: workDirForWorkspace,
    locale: readLocale,
    systemExtensionEnabled: () => systemExtensionEnabled(services.extensionHost),
    missing: missingRequirements,
    settled: loginPathSettled,
    label: requirementLabel,
    invokeInstall: (args, caller) =>
      services.extensionHost
        ? services.extensionHost.invoke('system', 'install', args, caller)
        : Promise.resolve({ ok: false, error: 'extension-unavailable' }),
  })
}
