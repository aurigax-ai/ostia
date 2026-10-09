import { EXTENSION_CATEGORIES, type ExtensionCategory } from '@shared/extensions'
import type {
  MarketplaceExtension,
  MarketplaceInfo,
  MarketplaceInstallState,
} from '@shared/extensions/marketplace'

export const BROWSE_FILTERS = ['all', 'installed', 'not-installed', 'updates'] as const

export type BrowseFilter = (typeof BROWSE_FILTERS)[number]

export type BrowseChip = 'installed' | 'update' | 'problem'

export interface BrowseEntry {
  key: string
  marketplace: MarketplaceInfo
  ext: MarketplaceExtension
}

export interface BrowseQuery {
  text: string
  filter: BrowseFilter
  category: ExtensionCategory | null
}

export function browseEntries(marketplaces: readonly MarketplaceInfo[]): BrowseEntry[] {
  return marketplaces.flatMap((marketplace) =>
    marketplace.extensions.map((ext) => ({
      key: browseKey(marketplace.id, ext.id),
      marketplace,
      ext,
    })),
  )
}

function browseKey(marketplaceId: string, extId: string): string {
  return `${marketplaceId}/${extId}`
}

export function browseChip(state: MarketplaceInstallState): BrowseChip | null {
  switch (state) {
    case 'installed':
      return 'installed'
    case 'update':
      return 'update'
    case 'replace':
    case 'conflict':
      return 'problem'
    case 'available':
      return null
  }
}

function inFilter(state: MarketplaceInstallState, filter: BrowseFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'installed':
      return state === 'installed' || state === 'update' || state === 'replace'
    case 'not-installed':
      return state === 'available' || state === 'conflict'
    case 'updates':
      return state === 'update'
  }
}

export function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.search(/[.!?。！？](\s|$)/)
  return end === -1 ? trimmed : trimmed.slice(0, end + 1)
}

export function filterBrowseEntries(
  entries: readonly BrowseEntry[],
  query: BrowseQuery,
  categoryLabel: (category: ExtensionCategory) => string,
): BrowseEntry[] {
  const text = query.text.trim().toLowerCase()
  return entries.filter(({ ext }) => {
    if (!inFilter(ext.state, query.filter)) return false
    if (query.category !== null && ext.category !== query.category) return false
    if (!text) return true
    return [ext.name, ext.description, ext.id, ext.category, categoryLabel(ext.category)].some(
      (field) => field.toLowerCase().includes(text),
    )
  })
}

export function browseCategories(entries: readonly BrowseEntry[]): ExtensionCategory[] {
  return EXTENSION_CATEGORIES.filter((category) =>
    entries.some(({ ext }) => ext.category === category),
  )
}
