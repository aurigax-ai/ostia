import { ipcRenderer } from 'electron'
import type { RequirementsReport } from '../shared/app/systemRequirements'
import type {
  SandboxEditError,
  SandboxEditResult,
  SandboxEnableResult,
  SandboxExposeResult,
  SandboxFixedPolicy,
  SandboxPortRow,
  SandboxViolation,
  WorkspaceSandbox,
} from '../shared/sandbox/sandbox'
import type { SandboxReadPreset } from '../shared/sandbox/sandboxPresets'
import type { SecretEntry, SecretGrant } from '../shared/sandbox/secrets'
import type { OstiaBridge } from '../shared/types'

export const sandboxBridge: Pick<OstiaBridge, 'secrets' | 'sandbox'> = {
  secrets: {
    view: (workspaceId) =>
      ipcRenderer.invoke('secrets:view', workspaceId) as Promise<{
        secrets: SecretEntry[]
        grants: SecretGrant[]
      } | null>,
    setGrants: (workspaceId, grants) =>
      ipcRenderer.invoke('secrets:set-grants', workspaceId, grants) as Promise<SandboxEditResult>,
    vaultSet: (workspaceId, key, value) =>
      ipcRenderer.invoke('secrets:vault-set', workspaceId, key, value) as Promise<boolean>,
    vaultDelete: (workspaceId, key) =>
      ipcRenderer.invoke('secrets:vault-delete', workspaceId, key) as Promise<boolean>,
  },
  sandbox: {
    onBlocked: (cb) => {
      const handler = (
        _event: unknown,
        blocked: { workspaceId: string; report: RequirementsReport },
      ): void => cb(blocked)
      ipcRenderer.on('sandbox:blocked', handler)
      return () => ipcRenderer.removeListener('sandbox:blocked', handler)
    },
    get: (workspaceId) =>
      ipcRenderer.invoke('sandbox:get', workspaceId) as Promise<WorkspaceSandbox | null>,
    setPaths: (workspaceId, kind, paths) =>
      ipcRenderer.invoke(
        'sandbox:set-paths',
        workspaceId,
        kind,
        paths,
      ) as Promise<SandboxEditResult>,
    checkPaths: (kind, paths) =>
      ipcRenderer.invoke('sandbox:check-paths', kind, paths) as Promise<SandboxEditError[]>,
    presets: () => ipcRenderer.invoke('sandbox:presets') as Promise<SandboxReadPreset[]>,
    setDomains: (workspaceId, domains) =>
      ipcRenderer.invoke('sandbox:set-domains', workspaceId, domains) as Promise<SandboxEditResult>,
    setDeniedDomains: (workspaceId, domains) =>
      ipcRenderer.invoke(
        'sandbox:set-denied-domains',
        workspaceId,
        domains,
      ) as Promise<SandboxEditResult>,
    setSwitches: (workspaceId, switches) =>
      ipcRenderer.invoke(
        'sandbox:set-switches',
        workspaceId,
        switches,
      ) as Promise<WorkspaceSandbox | null>,
    fixedPolicy: (workspaceId) =>
      ipcRenderer.invoke('sandbox:fixed-policy', workspaceId) as Promise<SandboxFixedPolicy | null>,
    stamp: (workspaceId) =>
      ipcRenderer.invoke('sandbox:stamp', workspaceId) as Promise<string | null>,
    violations: (workspaceId) =>
      ipcRenderer.invoke('sandbox:violations', workspaceId) as Promise<SandboxViolation[]>,
    clearViolations: (workspaceId) =>
      ipcRenderer.invoke('sandbox:clear-violations', workspaceId) as Promise<boolean>,
    setControls: (workspaceId, controls) =>
      ipcRenderer.invoke(
        'sandbox:set-controls',
        workspaceId,
        controls,
      ) as Promise<WorkspaceSandbox | null>,
    allowRefused: (workspaceId, host) =>
      ipcRenderer.invoke('sandbox:allow-refused', workspaceId, host) as Promise<boolean>,
    globalsChanged: () => ipcRenderer.invoke('sandbox:globals-changed') as Promise<boolean>,
    setPackages: (workspaceId, packages) =>
      ipcRenderer.invoke(
        'sandbox:set-packages',
        workspaceId,
        packages,
      ) as Promise<WorkspaceSandbox | null>,
    ports: (workspaceId) =>
      ipcRenderer.invoke('sandbox:ports', workspaceId) as Promise<SandboxPortRow[]>,
    expose: (workspaceId, port) =>
      ipcRenderer.invoke('sandbox:expose', workspaceId, port) as Promise<SandboxExposeResult>,
    unexpose: (workspaceId, port) =>
      ipcRenderer.invoke('sandbox:unexpose', workspaceId, port) as Promise<boolean>,
    setPortsPolicy: (workspaceId, policy) =>
      ipcRenderer.invoke(
        'sandbox:set-ports-policy',
        workspaceId,
        policy,
      ) as Promise<WorkspaceSandbox | null>,
    setEnabled: (workspaceId, enabled) =>
      ipcRenderer.invoke(
        'sandbox:set-enabled',
        workspaceId,
        enabled,
      ) as Promise<SandboxEnableResult>,
  },
}
