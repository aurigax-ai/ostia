import type { SecretGrant } from './secrets'

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

const SANDBOX_FOLDER_PROBLEMS = ['home', 'above-home', 'ostia-data'] as const
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

const SANDBOX_VIOLATION_REASONS = [
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

export interface SandboxLeftBehind {
  workspaceId: string
  workDir: string
  paths: string[]
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
  '~/.local/share/claude',
  '~/.local/share/uv/tools',
  '~/.local/share/uv/python',
  '~/.local/share/pipx',
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

const EXPOSE_PORT_MIN = 1024
const EXPOSE_PORT_MAX = 65535

export function checkExposePort(input: string | number): number | null {
  const text = String(input).trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= EXPOSE_PORT_MIN && port <= EXPOSE_PORT_MAX ? port : null
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

const PACKAGE_KEY = /^(npm|PyPI|crates\.io|Go):[^\s@][^\s]*$/

export function checkPackageKey(value: string): boolean {
  return PACKAGE_KEY.test(value)
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
