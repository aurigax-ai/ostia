export interface SandboxControls {
  allWorkspaces: boolean
  browser: 'allowlist' | 'unrestricted'
}

export interface WorkspaceSandbox {
  enabled: boolean
  allowRead: string[]
  domains: string[]
  controls: Partial<SandboxControls>
}

export interface SandboxGlobals {
  allowRead: string[]
  allowedDomains: string[]
  controls: SandboxControls
}

export interface ResolvedSandbox {
  allowRead: string[]
  domains: string[]
  controls: SandboxControls
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
]

export const DEFAULT_SANDBOX_GLOBALS: SandboxGlobals = {
  allowRead: DEFAULT_ALLOW_READ,
  allowedDomains: DEFAULT_ALLOWED_DOMAINS,
  controls: DEFAULT_CONTROLS,
}

export function emptyWorkspaceSandbox(): WorkspaceSandbox {
  return { enabled: false, allowRead: [], domains: [], controls: {} }
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
    domains: union(union(globals.allowedDomains, workspace.domains), sessionDomains),
    controls: { ...globals.controls, ...workspace.controls },
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
