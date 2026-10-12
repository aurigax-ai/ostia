import { browserUserAgent } from './browserUserAgent'

export const ELECTRON_AGENT_HOSTS: readonly string[] = [
  'accounts.google.com',
  'accounts.youtube.com',
]

export interface UserAgentBrand {
  brand: string
  version: string
}

export interface UserAgentMetadata {
  brands: UserAgentBrand[]
  fullVersionList: UserAgentBrand[]
  fullVersion: string
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitness: string
  wow64: boolean
}

export interface BrowserAgents {
  electron: string
  rewritten: string
  metadata: UserAgentMetadata
}

export interface AgentHost {
  chromeVersion: string
  platform: NodeJS.Platform
  systemVersion: string
  arch: string
}

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
const GREASE_VERSIONS = ['8', '99', '24']
const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
}

function platformVersion(systemVersion: string): string {
  const parts = systemVersion
    .split('.')
    .slice(0, 3)
    .map((part) => String(Number.parseInt(part, 10) || 0))
  while (parts.length < 3) parts.push('0')
  return parts.join('.')
}

export function electronAgentMetadata(host: AgentHost): UserAgentMetadata {
  const major = host.chromeVersion.split('.')[0]
  const seed = Number(major)
  const grease = {
    brand: `Not${GREASE_CHARS[seed % 11]}A${GREASE_CHARS[(seed + 1) % 11]}Brand`,
    version: GREASE_VERSIONS[seed % 3],
  }
  return {
    brands: [grease, { brand: 'Chromium', version: major }],
    fullVersionList: [
      { brand: grease.brand, version: `${grease.version}.0.0.0` },
      { brand: 'Chromium', version: host.chromeVersion },
    ],
    fullVersion: host.chromeVersion,
    platform: PLATFORM_NAMES[host.platform] ?? 'Linux',
    platformVersion: platformVersion(host.systemVersion),
    architecture: host.arch === 'arm64' || host.arch === 'arm' ? 'arm' : 'x86',
    model: '',
    mobile: false,
    bitness: host.arch === 'ia32' || host.arch === 'arm' ? '32' : '64',
    wow64: false,
  }
}

export function browserAgents(
  defaultAgent: string,
  appName: string,
  host: AgentHost,
): BrowserAgents {
  return {
    electron: defaultAgent,
    rewritten: browserUserAgent(defaultAgent, appName),
    metadata: electronAgentMetadata(host),
  }
}

export function wantsElectronAgent(
  url: string,
  hosts: readonly string[] = ELECTRON_AGENT_HOSTS,
): boolean {
  try {
    return hosts.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

export function agentFor(url: string, agents: BrowserAgents): string {
  return wantsElectronAgent(url) ? agents.electron : agents.rewritten
}

type RequestHeaders = Record<string, string>

export interface AgentSession {
  getUserAgent(): string
  setUserAgent(userAgent: string): void
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: { url: string; requestHeaders: RequestHeaders },
        callback: (response: { requestHeaders: RequestHeaders }) => void,
      ) => void,
    ): void
  }
}

const sessionAgents = new WeakMap<AgentSession, BrowserAgents>()

export function useBrowserAgents(
  session: AgentSession,
  appName: string,
  host: AgentHost,
): BrowserAgents {
  const known = sessionAgents.get(session)
  if (known) return known
  const agents = browserAgents(session.getUserAgent(), appName, host)
  sessionAgents.set(session, agents)
  session.setUserAgent(agents.rewritten)
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders: RequestHeaders = {}
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (name.toLowerCase() !== 'user-agent') requestHeaders[name] = value
    }
    requestHeaders['User-Agent'] = agentFor(details.url, agents)
    callback({ requestHeaders })
  })
  return agents
}

interface NavigationDetails {
  url: string
  isMainFrame: boolean
  isSameDocument?: boolean
}

export interface AgentGuest {
  debugger: {
    isAttached(): boolean
    sendCommand(method: string, params?: object): Promise<unknown>
  }
  on(
    event: 'did-start-navigation' | 'did-redirect-navigation',
    listener: (details: NavigationDetails) => void,
  ): unknown
}

const followedGuests = new WeakSet<AgentGuest>()

export function followAgentByHost(guest: AgentGuest, agents: BrowserAgents): void {
  if (followedGuests.has(guest) || !guest.debugger.isAttached()) return
  followedGuests.add(guest)
  const override = (userAgent: string): void => {
    void guest.debugger
      .sendCommand('Emulation.setUserAgentOverride', {
        userAgent,
        userAgentMetadata: agents.metadata,
      })
      .catch(() => {})
  }
  let current = agents.rewritten
  override(current)
  const follow = (url: string): void => {
    const next = agentFor(url, agents)
    if (next === current) return
    current = next
    override(next)
  }
  guest.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) follow(details.url)
  })
  guest.on('did-redirect-navigation', (details) => {
    if (details.isMainFrame) follow(details.url)
  })
}
