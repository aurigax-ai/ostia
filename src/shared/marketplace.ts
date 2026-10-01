import type { Capability } from './capabilities'
import type { ExtensionCategory } from './extensions'

export const MARKETPLACE_FEATURE = 'marketplace'
export const MARKETPLACE_MANIFEST_FILE = 'pine-marketplace.json'
export const MARKETPLACE_URL_MAX = 2000

export type MarketplaceInstallState = 'available' | 'installed' | 'update' | 'conflict'

export interface MarketplaceExtension {
  id: string
  name: string
  version: string
  description: string
  category: ExtensionCategory
  capabilities: Capability[]
  runsProcess: boolean
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
  remove: (marketplaceId: string) => Promise<MarketplaceResult>
  refresh: (marketplaceId: string) => Promise<MarketplaceResult>
  install: (marketplaceId: string, extId: string) => Promise<MarketplaceResult>
  uninstall: (extId: string) => Promise<MarketplaceResult>
}
