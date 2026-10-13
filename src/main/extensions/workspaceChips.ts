import type { WorkspaceChip } from '../../shared/extensions'

export function workspaceChipsForWindow(
  chips: readonly WorkspaceChip[],
  ownerOf: (workspaceId: string) => string | undefined,
  windowId: string,
): WorkspaceChip[] {
  return chips.filter((chip) => ownerOf(chip.workspaceId) === windowId)
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
