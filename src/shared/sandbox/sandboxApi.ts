import type { SecretEntry, SecretGrant } from './secrets'
import type { PortsPolicy, SandboxControls, SandboxEditError, SandboxEditResult, SandboxEnableResult, SandboxExposeResult, SandboxFixedPolicy, SandboxPathKind, SandboxPortRow, SandboxSwitches, SandboxViolation, WorkspacePackages, WorkspaceSandbox } from './sandbox'
import type { SandboxReadPreset } from './sandboxPresets'
import type { RequirementsReport } from '../app/systemRequirements'

interface SecretsApi {
  view: (workspaceId: string) => Promise<{ secrets: SecretEntry[]; grants: SecretGrant[] } | null>
  setGrants: (workspaceId: string, grants: SecretGrant[]) => Promise<SandboxEditResult>
  vaultSet: (workspaceId: string, key: string, value: string) => Promise<boolean>
  vaultDelete: (workspaceId: string, key: string) => Promise<boolean>
}

interface SandboxApi {
  get: (workspaceId: string) => Promise<WorkspaceSandbox | null>
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<SandboxEnableResult>
  setPaths: (
    workspaceId: string,
    kind: SandboxPathKind,
    paths: string[],
  ) => Promise<SandboxEditResult>
  checkPaths: (kind: SandboxPathKind, paths: string[]) => Promise<SandboxEditError[]>
  presets: () => Promise<SandboxReadPreset[]>
  setDomains: (workspaceId: string, domains: string[]) => Promise<SandboxEditResult>
  setDeniedDomains: (workspaceId: string, domains: string[]) => Promise<SandboxEditResult>
  setSwitches: (
    workspaceId: string,
    switches: Partial<SandboxSwitches>,
  ) => Promise<WorkspaceSandbox | null>
  fixedPolicy: (workspaceId?: string) => Promise<SandboxFixedPolicy | null>
  stamp: (workspaceId: string) => Promise<string | null>
  violations: (workspaceId: string) => Promise<SandboxViolation[]>
  clearViolations: (workspaceId: string) => Promise<boolean>
  setControls: (
    workspaceId: string,
    controls: Partial<SandboxControls>,
  ) => Promise<WorkspaceSandbox | null>
  allowRefused: (workspaceId: string, host: string) => Promise<boolean>
  globalsChanged: () => Promise<boolean>
  setPackages: (
    workspaceId: string,
    packages: WorkspacePackages,
  ) => Promise<WorkspaceSandbox | null>
  ports: (workspaceId: string) => Promise<SandboxPortRow[]>
  expose: (workspaceId: string, port: number) => Promise<SandboxExposeResult>
  unexpose: (workspaceId: string, port: number) => Promise<boolean>
  setPortsPolicy: (
    workspaceId: string,
    policy: PortsPolicy | undefined,
  ) => Promise<WorkspaceSandbox | null>
  onBlocked: (
    cb: (blocked: { workspaceId: string; report: RequirementsReport }) => void,
  ) => () => void
}

export interface SandboxBridge {
  sandbox: SandboxApi
  secrets: SecretsApi
}
