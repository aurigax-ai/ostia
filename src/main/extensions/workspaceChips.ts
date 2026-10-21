import type { InboxEntry, WorkspaceChip } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'

function ownedBy<T extends { workspaceId: string }>(
  items: readonly T[],
  ownerOf: (workspaceId: string) => string | undefined,
  windowId: string,
): T[] {
  return items.filter((item) => ownerOf(item.workspaceId) === windowId)
}

export function workspaceChipsForWindow(
  chips: readonly WorkspaceChip[],
  ownerOf: (workspaceId: string) => string | undefined,
  windowId: string,
): WorkspaceChip[] {
  return ownedBy(chips, ownerOf, windowId)
}

export function inboxEntriesForWindow(
  entries: readonly InboxEntry[],
  ownerOf: (workspaceId: string) => string | undefined,
  windowId: string,
): InboxEntry[] {
  return ownedBy(entries, ownerOf, windowId)
}

export type OwnerLookup = (workspaceId: string) => string | undefined

export function firstKnownOwner(...lookups: OwnerLookup[]): OwnerLookup {
  return (workspaceId) => {
    for (const lookup of lookups) {
      const owner = lookup(workspaceId)
      if (owner !== undefined) return owner
    }
    return undefined
  }
}
