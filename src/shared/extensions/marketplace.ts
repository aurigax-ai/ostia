import type { AgentHookEvent } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type {
  ExtensionCategory,
  ExtensionIcon,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'

export const MARKETPLACE_FEATURE = 'marketplace'
export const MARKETPLACE_URL_MAX = 2000
export const MARKETPLACE_CODE_SHAPE = /^[a-z2-7]{26}$/

export type MarketplaceInstallState =
  | 'available'
  | 'installed'
  | 'update'
  | 'replace'
  | 'conflict'
  | 'incompatible'

interface MarketplaceAgentHook {
  event: AgentHookEvent
  command: string
}

export interface MarketplaceExtension {
  id: string
  name: string
  version: string
  description: string
  category: ExtensionCategory
  icon?: ExtensionIcon
  capabilities: Capability[]
  runsProcess: boolean
  agentSkills: string[]
  agentHooks: MarketplaceAgentHook[]
  state: MarketplaceInstallState
  installedVersion?: string
  installedRevoked?: true
  needsApi?: string
}

export interface MarketplaceInfo {
  id: string
  url: string
  name: string
  description: string
  error?: string
  problems: string[]
  extensions: MarketplaceExtension[]
  installs: string[]
  unlisted: boolean
  official: boolean
  downloaded: boolean
}

export interface MarketplaceState {
  marketplaces: MarketplaceInfo[]
  installed: string[]
  prerelease: string[]
  dev: Record<string, string>
}

export type MarketplaceError =
  | 'invalid-url'
  | 'already-added'
  | 'git-missing'
  | 'clone-failed'
  | 'invalid-marketplace'
  | 'unknown-marketplace'
  | 'unknown-extension'
  | 'unknown-code'
  | 'conflict'
  | 'invalid-extension'
  | 'too-large'
  | 'not-installed'
  | 'official-marketplace'
  | 'needs-newer-app'
  | 'invalid-source'
  | 'write-failed'

export type MarketplaceResult =
  | { ok: true; state: MarketplaceState }
  | { ok: false; error: MarketplaceError; detail?: string; state: MarketplaceState }

export type MarketplaceFound =
  | { ok: true; marketplaceId: string; extension: MarketplaceExtension }
  | { ok: false; error: MarketplaceError; detail?: string }

export type DevSource =
  | { kind: 'folder'; path: string }
  | { kind: 'git'; url: string; branch: string; path?: string }

export interface MarketplaceApi {
  list: () => Promise<MarketplaceState>
  add: (url: string) => Promise<MarketplaceResult>
  remove: (marketplaceId: string, uninstallExtensions: boolean) => Promise<MarketplaceResult>
  refresh: (marketplaceId: string) => Promise<MarketplaceResult>
  install: (marketplaceId: string, extId: string) => Promise<MarketplaceResult>
  findCode: (code: string) => Promise<MarketplaceFound>
  installCode: (marketplaceId: string, code: string) => Promise<MarketplaceResult>
  uninstall: (extId: string) => Promise<MarketplaceResult>
  setPrerelease: (extId: string, enabled: boolean) => Promise<MarketplaceResult>
  installDev: (source: DevSource) => Promise<MarketplaceResult>
}
