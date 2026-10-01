import { SECRET_GRANT_MODES, type SecretGrant, type SecretGrantMode } from './secrets'

export interface SandboxControls {
  allWorkspaces: boolean
  browser: 'allowlist' | 'unrestricted'
}

export interface SandboxSwitches {
  unixSockets: boolean
  gitConfig: boolean
  strictDomains: boolean
}

export const SANDBOX_SWITCHES = ['unixSockets', 'gitConfig', 'strictDomains'] as const

export const DEFAULT_SWITCHES: SandboxSwitches = {
  unixSockets: true,
  gitConfig: false,
  strictDomains: false,
}

export const SANDBOX_PATH_KINDS = [
  'allowRead',
  'allowWrite',
  'denyRead',
  'denyWrite',
  'allowSockets',
] as const
export type SandboxPathKind = (typeof SANDBOX_PATH_KINDS)[number]

export const SANDBOX_LIST_MAX = 200
export const SANDBOX_PATH_MAX = 1024

export const PORTS_POLICIES = ['ask', 'allow', 'deny'] as const
export type PortsPolicy = (typeof PORTS_POLICIES)[number]

export interface PackageSettings {
  malware: boolean
  cooldownDays: number
  denyList: string[]
  allowOnly: string[] | null
}

export const DEFAULT_PACKAGE_SETTINGS: PackageSettings = {
  malware: true,
  cooldownDays: 2,
  denyList: [],
  allowOnly: null,
}

export type WorkspacePackages = Partial<PackageSettings> & { allowances?: string[] }

export interface WorkspaceSandbox {
  enabled: boolean
  allowRead: string[]
  allowWrite?: string[]
  denyRead?: string[]
  denyWrite?: string[]
  domains: string[]
  deniedDomains?: string[]
  allowSockets?: string[]
  controls: Partial<SandboxControls>
  switches?: Partial<SandboxSwitches>
  ports?: PortsPolicy
  secrets?: SecretGrant[]
  packages?: WorkspacePackages
}

export interface SandboxGlobals {
  allowRead: string[]
  allowWrite?: string[]
  denyRead?: string[]
  denyWrite?: string[]
  allowedDomains: string[]
  deniedDomains?: string[]
  allowSockets?: string[]
  controls: SandboxControls
  switches?: SandboxSwitches
  portsPolicy?: PortsPolicy
  packages?: PackageSettings
}

export interface SandboxPortRow {
  port: number
  process: string | null
  exposed: boolean
}

export type SandboxExposeResult = { ok: true; port: number } | { ok: false; error: string }

export interface DomainRefusal {
  host: string
  count: number
  last: number
}

export interface SandboxEditError {
  value: string
  reason: string
}

export type SandboxEditResult =
  | { ok: true; settings: WorkspaceSandbox }
  | { ok: false; errors: SandboxEditError[] }

export interface ResolvedSandbox {
  allowRead: string[]
  allowWrite: string[]
  denyRead: string[]
  denyWrite: string[]
  domains: string[]
  deniedDomains: string[]
  allowSockets: string[]
  controls: SandboxControls
  switches: SandboxSwitches
  portsPolicy: PortsPolicy
}

export interface SandboxFixedPolicy {
  readable: string[]
  writable: string[]
  hidden: string[]
  readOnly: string[]
  hiddenSockets: string[]
  socketBlocking: boolean
}

export const SANDBOX_FOLDER_PROBLEMS = ['home', 'above-home', 'pine-data'] as const
export type SandboxFolderReason = (typeof SANDBOX_FOLDER_PROBLEMS)[number]

export interface SandboxFolderProblem {
  folder: string
  reason: SandboxFolderReason
}

export type SandboxEnableResult =
  | { ok: true; settings: WorkspaceSandbox }
  | { ok: false; reason: 'not-owned' | 'missing-programs' }
  | { ok: false; reason: 'folder'; problem: SandboxFolderProblem }

export type SandboxViolationKind = 'network' | 'write' | 'read' | 'other'

export const SANDBOX_VIOLATION_REASONS = [
  'not-allowed',
  'blocked',
  'refused',
  'address',
  'request',
  'outside',
  'read-only',
  'other',
] as const
export type SandboxViolationReason = (typeof SANDBOX_VIOLATION_REASONS)[number]

export interface SandboxViolation {
  id: string
  kind: SandboxViolationKind
  target: string
  reason: SandboxViolationReason
  detail: string
  count: number
  last: number
  allowHost?: string
}

export const DEFAULT_CONTROLS: SandboxControls = { allWorkspaces: false, browser: 'allowlist' }

export const DEFAULT_ALLOW_READ = [
  '~/.zshrc',
  '~/.zshenv',
  '~/.zprofile',
  '~/.bashrc',
  '~/.bash_profile',
  '~/.profile',
  '~/.p10k.zsh',
  '~/.oh-my-zsh',
  '~/.cargo',
  '~/.rustup',
  '~/.local/bin',
  '~/.nvm',
  '~/.dircolors',
  '~/.config/vivid',
  '~/.config/bat',
  '~/.config/eza',
  '~/.config/lsd',
  '~/.config/starship.toml',
]

export const DEFAULT_ALLOWED_DOMAINS = [
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'github.com',
  '*.github.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
]

export const DEFAULT_SANDBOX_GLOBALS: SandboxGlobals = {
  allowRead: DEFAULT_ALLOW_READ,
  allowedDomains: DEFAULT_ALLOWED_DOMAINS,
  controls: DEFAULT_CONTROLS,
  portsPolicy: 'ask',
}

export function emptyWorkspaceSandbox(): WorkspaceSandbox {
  return { enabled: false, allowRead: [], domains: [], controls: {} }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .map((item) => JSON.stringify(item))
      .sort()
  }
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== undefined) out[key] = canonical(item)
  }
  return out
}

export function sameWorkspaceSandbox(a: WorkspaceSandbox, b: WorkspaceSandbox): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export type SandboxMergeRefusal = 'sandbox-mixed' | 'sandbox-differs'

export function sandboxMergeRefusal(
  source: WorkspaceSandbox,
  target: WorkspaceSandbox,
): SandboxMergeRefusal | null {
  if (source.enabled !== target.enabled) return 'sandbox-mixed'
  if (source.enabled && !sameWorkspaceSandbox(source, target)) return 'sandbox-differs'
  return null
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])]
}

export function resolveSandbox(
  globals: SandboxGlobals,
  workspace: WorkspaceSandbox,
  sessionDomains: readonly string[] = [],
): ResolvedSandbox {
  return {
    allowRead: union(globals.allowRead, workspace.allowRead),
    allowWrite: union(globals.allowWrite ?? [], workspace.allowWrite ?? []),
    denyRead: union(globals.denyRead ?? [], workspace.denyRead ?? []),
    denyWrite: union(globals.denyWrite ?? [], workspace.denyWrite ?? []),
    domains: union(union(globals.allowedDomains, workspace.domains), sessionDomains),
    deniedDomains: union(globals.deniedDomains ?? [], workspace.deniedDomains ?? []),
    allowSockets: union(globals.allowSockets ?? [], workspace.allowSockets ?? []),
    controls: { ...globals.controls, ...workspace.controls },
    switches: { ...DEFAULT_SWITCHES, ...globals.switches, ...workspace.switches },
    portsPolicy: workspace.ports ?? globals.portsPolicy ?? 'ask',
  }
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST_PATTERN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+(?::(\\d{1,5}))?$`)

export type DomainCheck = { ok: true; domain: string } | { ok: false; reason: string }

export function checkDomainPattern(input: string): DomainCheck {
  const domain = input.trim().toLowerCase()
  if (!domain) return { ok: false, reason: 'empty' }
  if (domain === '*' || domain.startsWith('*:')) return { ok: false, reason: 'wildcard-all' }
  if (domain === 'localhost' || domain.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost' }
  }
  if (/^[\d.]+(?::\d+)?$/.test(domain) || domain.includes('[') || domain.includes('::')) {
    return { ok: false, reason: 'ip-literal' }
  }
  const match = HOST_PATTERN.exec(domain)
  if (!match) return { ok: false, reason: 'invalid' }
  if (match[1] !== undefined) {
    const port = Number(match[1])
    if (port < 1 || port > 65535) return { ok: false, reason: 'invalid-port' }
  }
  return { ok: true, domain }
}

export const EXPOSE_PORT_MIN = 1024
export const EXPOSE_PORT_MAX = 65535

export function checkExposePort(input: string | number): number | null {
  const text = String(input).trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= EXPOSE_PORT_MIN && port <= EXPOSE_PORT_MAX ? port : null
}

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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const out: Partial<SandboxSwitches> = {}
  for (const key of SANDBOX_SWITCHES) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') return null
    out[key] = raw[key]
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

function splitPattern(pattern: string): { host: string; port: number | null } {
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(pattern.toLowerCase())
  return { host: match?.[1] ?? '', port: match?.[2] ? Number(match[2]) : null }
}

export function hostMatches(host: string, port: number, patterns: readonly string[]): boolean {
  const target = host.toLowerCase()
  return patterns.some((raw) => {
    const pattern = splitPattern(raw)
    if (pattern.port !== null && pattern.port !== port) return false
    if (pattern.host.startsWith('*.')) return target.endsWith(pattern.host.slice(1))
    return target === pattern.host
  })
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/

export function checkSecretGrant(grant: SecretGrant): boolean {
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

const PACKAGE_KEY = /^(npm|PyPI|crates\.io|Go):[^\s@][^\s]*$/

export function checkPackageKey(value: string): boolean {
  return PACKAGE_KEY.test(value)
}

function packageList(value: unknown): string[] | null {
  const list = stringList(value)
  return list?.every(checkPackageKey) ? list : null
}

export function parsePackageSettings(value: unknown): PackageSettings | null {
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

export function resolvePackages(
  globals: SandboxGlobals,
  workspace: WorkspaceSandbox,
): PackageSettings & { allowances: string[] } {
  const base = globals.packages ?? DEFAULT_PACKAGE_SETTINGS
  const own = workspace.packages ?? {}
  return {
    malware: own.malware ?? base.malware,
    cooldownDays: own.cooldownDays ?? base.cooldownDays,
    denyList: [...new Set([...base.denyList, ...(own.denyList ?? [])])],
    allowOnly: own.allowOnly !== undefined ? own.allowOnly : base.allowOnly,
    allowances: own.allowances ?? [],
  }
}
