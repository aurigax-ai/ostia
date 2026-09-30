import { ipcMain } from 'electron'
import {
  type DomainRefusal,
  PORTS_POLICIES,
  type PortsPolicy,
  type SandboxControls,
  type SandboxEditResult,
  type WorkspaceSandbox,
  checkDomainPattern,
  checkExposePort,
} from '../../shared/sandbox'
import type { MissingRequirement } from '../../shared/systemRequirements'
import type { DomainRequests } from './domainRequests'
import type { PortRequests, PortRow } from './portRequests'
import { type ReadPathEnv, checkReadPath } from './readPaths'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

export interface SandboxIpcDeps {
  sandboxes: WorkspaceSandboxes
  ownerWindow: (workspaceId: string) => string | undefined
  missing?: () => MissingRequirement[]
  domains?: DomainRequests
  ports?: PortRequests
  readPathEnv?: () => ReadPathEnv
  refreshAll?: () => void
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
}

function parseControlsPatch(value: unknown): Partial<SandboxControls> | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const out: Partial<SandboxControls> = {}
  if ('allWorkspaces' in raw) {
    if (raw.allWorkspaces !== undefined && typeof raw.allWorkspaces !== 'boolean') return null
    if (typeof raw.allWorkspaces === 'boolean') out.allWorkspaces = raw.allWorkspaces
  }
  if ('browser' in raw) {
    if (raw.browser !== 'allowlist' && raw.browser !== 'unrestricted' && raw.browser !== undefined)
      return null
    if (raw.browser) out.browser = raw.browser
  }
  return out
}

export function ownsWorkspace(
  deps: Pick<SandboxIpcDeps, 'ownerWindow'>,
  senderId: number,
  workspaceId: unknown,
): workspaceId is string {
  return typeof workspaceId === 'string' && deps.ownerWindow(workspaceId) === String(senderId)
}

export function registerSandboxIpc(deps: SandboxIpcDeps): void {
  ipcMain.handle('sandbox:get', (e, workspaceId: unknown): WorkspaceSandbox | null =>
    ownsWorkspace(deps, e.sender.id, workspaceId) ? deps.sandboxes.settings(workspaceId) : null,
  )
  ipcMain.handle(
    'sandbox:set-enabled',
    (e, workspaceId: unknown, enabled: unknown): WorkspaceSandbox | null => {
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || typeof enabled !== 'boolean') {
        return null
      }
      if (enabled && (deps.missing?.() ?? []).length > 0) return null
      return deps.sandboxes.update(workspaceId, (current) => ({ ...current, enabled }))
    },
  )

  ipcMain.handle(
    'sandbox:set-allow-read',
    (e, workspaceId: unknown, paths: unknown): SandboxEditResult => {
      const list = stringArray(paths)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !list || !deps.readPathEnv) {
        return { ok: false, errors: [] }
      }
      const env = deps.readPathEnv()
      const checked = list.map((path) => ({ path, check: checkReadPath(path, env) }))
      const errors = checked.flatMap(({ path, check }) =>
        check.ok ? [] : [{ value: path, reason: check.reason }],
      )
      if (errors.length > 0) return { ok: false, errors }
      const allowRead = [...new Set(checked.map(({ check }) => (check.ok ? check.path : '')))]
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, (c) => ({ ...c, allowRead })),
      }
    },
  )
  ipcMain.handle(
    'sandbox:set-domains',
    (e, workspaceId: unknown, domains: unknown): SandboxEditResult => {
      const list = stringArray(domains)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !list) return { ok: false, errors: [] }
      const checked = list.map((value) => ({ value, check: checkDomainPattern(value) }))
      const errors = checked.flatMap(({ value, check }) =>
        check.ok ? [] : [{ value, reason: check.reason }],
      )
      if (errors.length > 0) return { ok: false, errors }
      const next = [...new Set(checked.map(({ check }) => (check.ok ? check.domain : '')))]
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, (c) => ({ ...c, domains: next })),
      }
    },
  )
  ipcMain.handle(
    'sandbox:set-controls',
    (e, workspaceId: unknown, patch: unknown): WorkspaceSandbox | null => {
      const controls = parseControlsPatch(patch)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !controls) return null
      return deps.sandboxes.update(workspaceId, (c) => ({ ...c, controls }))
    },
  )
  ipcMain.handle('sandbox:refusals', (e, workspaceId: unknown): DomainRefusal[] =>
    ownsWorkspace(deps, e.sender.id, workspaceId)
      ? (deps.domains?.refusals(workspaceId) ?? [])
      : [],
  )
  ipcMain.handle('sandbox:allow-refused', (e, workspaceId: unknown, host: unknown): boolean => {
    if (!ownsWorkspace(deps, e.sender.id, workspaceId) || typeof host !== 'string') return false
    if (!checkDomainPattern(host).ok || !deps.domains) return false
    deps.domains.allowFromView(workspaceId, host)
    return true
  })
  ipcMain.handle('sandbox:ports', (e, workspaceId: unknown): PortRow[] =>
    ownsWorkspace(deps, e.sender.id, workspaceId) ? (deps.ports?.ports(workspaceId) ?? []) : [],
  )
  ipcMain.handle('sandbox:expose', async (e, workspaceId: unknown, port: unknown) => {
    const checked = checkExposePort(String(port))
    if (!ownsWorkspace(deps, e.sender.id, workspaceId) || checked === null || !deps.ports) {
      return { ok: false, error: 'invalid-port' }
    }
    return deps.ports.exposeByHuman(workspaceId, checked)
  })
  ipcMain.handle('sandbox:unexpose', async (e, workspaceId: unknown, port: unknown) => {
    if (!ownsWorkspace(deps, e.sender.id, workspaceId) || typeof port !== 'number') return false
    await deps.ports?.unexposeByHuman(workspaceId, port)
    return true
  })
  ipcMain.handle(
    'sandbox:set-ports-policy',
    (e, workspaceId: unknown, policy: unknown): WorkspaceSandbox | null => {
      if (!ownsWorkspace(deps, e.sender.id, workspaceId)) return null
      if (policy !== undefined && !PORTS_POLICIES.includes(policy as PortsPolicy)) return null
      return deps.sandboxes.update(workspaceId, ({ ports: _old, ...rest }) =>
        policy === undefined ? rest : { ...rest, ports: policy as PortsPolicy },
      )
    },
  )
  ipcMain.handle('sandbox:globals-changed', () => {
    deps.refreshAll?.()
    return true
  })
}
