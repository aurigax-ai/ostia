import { ipcMain } from 'electron'
import {
  PORTS_POLICIES,
  type PortsPolicy,
  SANDBOX_LIST_MAX,
  SANDBOX_PATH_KINDS,
  type SandboxControls,
  type SandboxEditError,
  type SandboxEditResult,
  type SandboxEnableResult,
  type SandboxFixedPolicy,
  type SandboxPathKind,
  type SandboxViolation,
  type WorkspaceSandbox,
  checkDomainPattern,
  checkExposePort,
  parseSwitches,
  parseWorkspacePackages,
} from '../../shared/sandbox'
import type { SandboxReadPreset } from '../../shared/sandboxPresets'
import type { MissingRequirement } from '../../shared/systemRequirements'
import type { DomainRequests } from './domainRequests'
import { checkSandboxPaths } from './pathChecks'
import type { PortRequests, PortRow } from './portRequests'
import { availableReadPresets } from './presets'
import type { ViolationLog } from './violations'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

export interface SandboxIpcDeps {
  sandboxes: WorkspaceSandboxes
  ownerWindow: (workspaceId: string) => string | undefined
  missing?: () => MissingRequirement[]
  domains?: DomainRequests
  ports?: PortRequests
  violations?: ViolationLog
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

function pathKind(value: unknown): SandboxPathKind | null {
  return SANDBOX_PATH_KINDS.includes(value as SandboxPathKind) ? (value as SandboxPathKind) : null
}

const TOO_MANY: SandboxEditError = { value: '', reason: 'too-many' }

type DomainListCheck = { ok: true; domains: string[] } | { ok: false; errors: SandboxEditError[] }

function checkDomains(list: readonly string[]): DomainListCheck {
  if (list.length > SANDBOX_LIST_MAX) return { ok: false, errors: [TOO_MANY] }
  const domains: string[] = []
  const errors: SandboxEditError[] = []
  for (const value of list) {
    const check = checkDomainPattern(value)
    if (check.ok) domains.push(check.domain)
    else errors.push({ value, reason: check.reason })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, domains: [...new Set(domains)] }
}

function withList<K extends keyof WorkspaceSandbox>(
  current: WorkspaceSandbox,
  key: K,
  list: string[],
  required: boolean,
): WorkspaceSandbox {
  const { [key]: _old, ...rest } = current
  return (list.length > 0 || required ? { ...rest, [key]: list } : rest) as WorkspaceSandbox
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
    (e, workspaceId: unknown, enabled: unknown): SandboxEnableResult => {
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || typeof enabled !== 'boolean') {
        return { ok: false, reason: 'not-owned' }
      }
      if (enabled && (deps.missing?.() ?? []).length > 0) {
        return { ok: false, reason: 'missing-programs' }
      }
      const problem = enabled ? deps.sandboxes.folderProblem(workspaceId) : null
      if (problem) return { ok: false, reason: 'folder', problem }
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, (current) => ({ ...current, enabled })),
      }
    },
  )

  ipcMain.handle(
    'sandbox:set-paths',
    (e, workspaceId: unknown, kind: unknown, paths: unknown): SandboxEditResult => {
      const list = stringArray(paths)
      const key = pathKind(kind)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !list || !key) {
        return { ok: false, errors: [] }
      }
      if (list.length > SANDBOX_LIST_MAX) return { ok: false, errors: [TOO_MANY] }
      const current = deps.sandboxes.settings(workspaceId)[key] ?? []
      const added = list.filter((value) => !current.includes(value))
      const checked = checkSandboxPaths(key, added, deps.sandboxes.pathEnv(workspaceId))
      if (!checked.ok) return checked
      const accepted = [...checked.paths]
      const next = [
        ...new Set(list.map((value) => (current.includes(value) ? value : accepted.shift()))),
      ].filter((value): value is string => value !== undefined)
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, (c) =>
          withList(c, key, next, key === 'allowRead'),
        ),
      }
    },
  )
  ipcMain.handle('sandbox:check-paths', (_e, kind: unknown, paths: unknown): SandboxEditError[] => {
    const list = stringArray(paths)
    const key = pathKind(kind)
    if (!list || !key) return [{ value: '', reason: 'invalid' }]
    const checked = checkSandboxPaths(key, list, deps.sandboxes.pathEnv())
    return checked.ok ? [] : checked.errors
  })
  ipcMain.handle('sandbox:presets', (): SandboxReadPreset[] =>
    availableReadPresets(deps.sandboxes.pathEnv()),
  )
  ipcMain.handle(
    'sandbox:set-domains',
    (e, workspaceId: unknown, domains: unknown): SandboxEditResult => {
      const list = stringArray(domains)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !list) return { ok: false, errors: [] }
      const checked = checkDomains(list)
      if (!checked.ok) return checked
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, (c) => ({ ...c, domains: checked.domains })),
      }
    },
  )
  ipcMain.handle(
    'sandbox:set-denied-domains',
    (e, workspaceId: unknown, domains: unknown): SandboxEditResult => {
      const list = stringArray(domains)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !list) return { ok: false, errors: [] }
      const checked = checkDomains(list)
      if (!checked.ok) return checked
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, (c) =>
          withList(c, 'deniedDomains', checked.domains, false),
        ),
      }
    },
  )
  ipcMain.handle(
    'sandbox:set-switches',
    (e, workspaceId: unknown, patch: unknown): WorkspaceSandbox | null => {
      const switches = patch === undefined ? null : parseSwitches(patch)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !switches) return null
      return deps.sandboxes.update(workspaceId, ({ switches: _old, ...rest }) =>
        Object.keys(switches).length === 0 ? rest : { ...rest, switches },
      )
    },
  )
  ipcMain.handle('sandbox:fixed-policy', (e, workspaceId: unknown): SandboxFixedPolicy | null => {
    if (workspaceId === undefined) return deps.sandboxes.fixedPolicy()
    return ownsWorkspace(deps, e.sender.id, workspaceId)
      ? deps.sandboxes.fixedPolicy(workspaceId)
      : null
  })
  ipcMain.handle('sandbox:stamp', (e, workspaceId: unknown): string | null =>
    ownsWorkspace(deps, e.sender.id, workspaceId) && deps.sandboxes.isEnabled(workspaceId)
      ? deps.sandboxes.wrapStamp(workspaceId)
      : null,
  )
  ipcMain.handle('sandbox:violations', (e, workspaceId: unknown): SandboxViolation[] =>
    ownsWorkspace(deps, e.sender.id, workspaceId)
      ? (deps.violations?.list(deps.sandboxes.owner(workspaceId)) ?? [])
      : [],
  )
  ipcMain.handle('sandbox:clear-violations', (e, workspaceId: unknown): boolean => {
    if (!ownsWorkspace(deps, e.sender.id, workspaceId)) return false
    deps.violations?.clear(deps.sandboxes.owner(workspaceId))
    return true
  })
  ipcMain.handle(
    'sandbox:set-controls',
    (e, workspaceId: unknown, patch: unknown): WorkspaceSandbox | null => {
      const controls = parseControlsPatch(patch)
      if (!ownsWorkspace(deps, e.sender.id, workspaceId) || !controls) return null
      return deps.sandboxes.update(workspaceId, (c) => ({ ...c, controls }))
    },
  )
  ipcMain.handle('sandbox:allow-refused', (e, workspaceId: unknown, host: unknown): boolean => {
    if (!ownsWorkspace(deps, e.sender.id, workspaceId) || typeof host !== 'string') return false
    if (!checkDomainPattern(host).ok || !deps.domains) return false
    deps.domains.allowFromView(workspaceId, host)
    return true
  })
  ipcMain.handle(
    'sandbox:set-packages',
    (e, workspaceId: unknown, packages: unknown): WorkspaceSandbox | null => {
      if (!ownsWorkspace(deps, e.sender.id, workspaceId)) return null
      const parsed = parseWorkspacePackages(packages)
      if (!parsed) return null
      const { allowances: _ignored, ...settings } = parsed
      return deps.sandboxes.update(workspaceId, (current) => {
        const allowances = current.packages?.allowances
        const next = { ...settings, ...(allowances ? { allowances } : {}) }
        const { packages: _old, ...rest } = current
        return Object.keys(next).length === 0 ? rest : { ...rest, packages: next }
      })
    },
  )
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
