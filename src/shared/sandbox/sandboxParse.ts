import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  checkPackageKey,
  DEFAULT_PACKAGE_SETTINGS,
  DEFAULT_SANDBOX_GLOBALS,
  DEFAULT_SWITCHES,
  type PackageSettings,
  PORTS_POLICIES,
  type PortsPolicy,
  SANDBOX_SWITCHES,
  type SandboxControls,
  type SandboxGlobals,
  type SandboxSwitches,
  type WorkspacePackages,
  type WorkspaceSandbox,
} from './sandbox'
import { SECRET_GRANT_MODES, type SecretGrant, type SecretGrantMode } from './secrets'

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
}

function parseControls(value: unknown): Partial<SandboxControls> | null {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const out: Partial<SandboxControls> = {}
  if (raw.allWorkspaces !== undefined) {
    if (typeof raw.allWorkspaces !== 'boolean') return null
    out.allWorkspaces = raw.allWorkspaces
  }
  if (raw.browser !== undefined) {
    if (raw.browser !== 'allowlist' && raw.browser !== 'unrestricted') return null
    out.browser = raw.browser
  }
  return out
}

export function parseSwitches(value: unknown): Partial<SandboxSwitches> | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const out: Partial<SandboxSwitches> = {}
  for (const key of SANDBOX_SWITCHES) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') return null
    out[key] = value[key]
  }
  return out
}

const OPTIONAL_LISTS = [
  'allowWrite',
  'denyRead',
  'denyWrite',
  'deniedDomains',
  'allowSockets',
] as const

function optionalLists(
  raw: Record<string, unknown>,
): Partial<Record<(typeof OPTIONAL_LISTS)[number], string[]>> | null {
  const out: Partial<Record<(typeof OPTIONAL_LISTS)[number], string[]>> = {}
  for (const key of OPTIONAL_LISTS) {
    const list = stringList(raw[key] ?? [])
    if (!list) return null
    if (list.length > 0) out[key] = list
  }
  return out
}

export function parseWorkspaceSandbox(value: unknown): WorkspaceSandbox | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const allowRead = stringList(raw.allowRead ?? [])
  const domains = stringList(raw.domains ?? [])
  const controls = parseControls(raw.controls)
  const lists = optionalLists(raw)
  const switches = parseSwitches(raw.switches)
  if (typeof raw.enabled !== 'boolean' || !allowRead || !domains || !controls) return null
  if (!lists || !switches) return null
  if (raw.ports !== undefined && !PORTS_POLICIES.includes(raw.ports as PortsPolicy)) return null
  const secrets = parseSecretGrants(raw.secrets)
  if (!secrets) return null
  const packages = raw.packages === undefined ? undefined : parseWorkspacePackages(raw.packages)
  if (packages === null) return null
  return {
    enabled: raw.enabled,
    allowRead,
    domains,
    controls,
    ...lists,
    ...(Object.keys(switches).length === 0 ? {} : { switches }),
    ...(raw.ports === undefined ? {} : { ports: raw.ports as PortsPolicy }),
    ...(secrets.length === 0 ? {} : { secrets }),
    ...(packages === undefined ? {} : { packages }),
  }
}

export function parseSandboxGlobals(value: unknown): SandboxGlobals {
  if (typeof value !== 'object' || value === null) return DEFAULT_SANDBOX_GLOBALS
  const raw = value as Record<string, unknown>
  const controls = parseControls(raw.controls) ?? {}
  return {
    allowRead: stringList(raw.allowRead) ?? DEFAULT_SANDBOX_GLOBALS.allowRead,
    allowWrite: stringList(raw.allowWrite) ?? [],
    denyRead: stringList(raw.denyRead) ?? [],
    denyWrite: stringList(raw.denyWrite) ?? [],
    allowedDomains: stringList(raw.allowedDomains) ?? DEFAULT_SANDBOX_GLOBALS.allowedDomains,
    deniedDomains: stringList(raw.deniedDomains) ?? [],
    allowSockets: stringList(raw.allowSockets) ?? [],
    controls: { ...DEFAULT_SANDBOX_GLOBALS.controls, ...controls },
    switches: { ...DEFAULT_SWITCHES, ...(parseSwitches(raw.switches) ?? {}) },
    packages: parsePackageSettings(raw.packages) ?? DEFAULT_PACKAGE_SETTINGS,
    portsPolicy: PORTS_POLICIES.includes(raw.portsPolicy as PortsPolicy)
      ? (raw.portsPolicy as PortsPolicy)
      : DEFAULT_SANDBOX_GLOBALS.portsPolicy,
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/

function checkSecretGrant(grant: SecretGrant): boolean {
  if (typeof grant.id !== 'string' || !grant.id) return false
  if (!SECRET_GRANT_MODES.includes(grant.mode)) return false
  if (grant.name === undefined) return true
  if (grant.mode === 'env') return ENV_NAME.test(grant.name)
  if (grant.mode === 'file') return FILE_NAME.test(grant.name) && grant.name !== 'agent.sock'
  return false
}

export function parseSecretGrants(value: unknown): SecretGrant[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: SecretGrant[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null
    const { id, mode, name } = raw as Record<string, unknown>
    const grant: SecretGrant = {
      id: String(id),
      mode: mode as SecretGrantMode,
      ...(typeof name === 'string' ? { name } : {}),
    }
    if (typeof id !== 'string' || !checkSecretGrant(grant)) return null
    out.push(grant)
  }
  return out
}

function packageList(value: unknown): string[] | null {
  const list = stringList(value)
  return list?.every(checkPackageKey) ? list : null
}

function parsePackageSettings(value: unknown): PackageSettings | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const denyList = packageList(raw.denyList ?? [])
  const allowOnly =
    raw.allowOnly === null || raw.allowOnly === undefined ? null : packageList(raw.allowOnly)
  const cooldown = Number(raw.cooldownDays ?? DEFAULT_PACKAGE_SETTINGS.cooldownDays)
  if (
    !denyList ||
    (raw.allowOnly && !allowOnly) ||
    !Number.isInteger(cooldown) ||
    cooldown < 0 ||
    cooldown > 60
  ) {
    return null
  }
  return {
    malware: raw.malware !== false,
    cooldownDays: cooldown,
    denyList,
    allowOnly,
  }
}

export function parseWorkspacePackages(value: unknown): WorkspacePackages | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const out: WorkspacePackages = {}
  if (raw.malware !== undefined) {
    if (typeof raw.malware !== 'boolean') return null
    out.malware = raw.malware
  }
  if (raw.cooldownDays !== undefined) {
    const days = Number(raw.cooldownDays)
    if (!Number.isInteger(days) || days < 0 || days > 60) return null
    out.cooldownDays = days
  }
  if (raw.denyList !== undefined) {
    const list = packageList(raw.denyList)
    if (!list) return null
    out.denyList = list
  }
  if (raw.allowOnly !== undefined) {
    const list = raw.allowOnly === null ? null : packageList(raw.allowOnly)
    if (raw.allowOnly !== null && !list) return null
    out.allowOnly = list
  }
  if (raw.allowances !== undefined) {
    const list = stringList(raw.allowances)
    if (!list) return null
    out.allowances = list
  }
  return out
}
