import type { AgentHookEvent } from './agentPlugins'
import type { Capability } from './capabilities'
import type { ExtensionCategory, ExtensionIcon } from './extensions'

export const MARKETPLACE_FEATURE = 'marketplace'
export const MARKETPLACE_MANIFEST_FILE = 'ostia-marketplace.json'
export const MARKETPLACE_URL_MAX = 2000
export const MARKETPLACE_CODE_PATTERN = /^[a-z2-7]{26}$/

export type MarketplaceInstallState = 'available' | 'installed' | 'update' | 'replace' | 'conflict'

export interface MarketplaceAgentHook {
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
}

export interface MarketplaceState {
  marketplaces: MarketplaceInfo[]
  installed: string[]
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
  | 'write-failed'

export type MarketplaceResult =
  | { ok: true; state: MarketplaceState }
  | { ok: false; error: MarketplaceError; detail?: string; state: MarketplaceState }

export interface MarketplaceApi {
  list: () => Promise<MarketplaceState>
  add: (url: string) => Promise<MarketplaceResult>
  remove: (marketplaceId: string, uninstallExtensions: boolean) => Promise<MarketplaceResult>
  refresh: (marketplaceId: string) => Promise<MarketplaceResult>
  install: (marketplaceId: string, extId: string) => Promise<MarketplaceResult>
  installCode: (marketplaceId: string, code: string) => Promise<MarketplaceResult>
  uninstall: (extId: string) => Promise<MarketplaceResult>
}
