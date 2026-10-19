import type { BrowseLimits } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import type { EntryRead } from './archiveFile'
import type { RawEntry } from './archiveTree'

export interface BrowseTarget {
  extId: string
  kind: string
  fd: number
  size: number
}

export type ProviderListing = { ok: true; entries: RawEntry[] } | { ok: false; error: string }

export interface BrowseProviders {
  kindFor(name: string): { extId: string; kind: string } | null
  list(target: BrowseTarget, limits: BrowseLimits, signal: AbortSignal): Promise<ProviderListing>
  read(
    target: BrowseTarget,
    index: number,
    max: number,
    limits: BrowseLimits,
    signal: AbortSignal,
  ): Promise<EntryRead>
}
