import type { WorkspaceChip } from '../shared/extensions'

export function workspaceChipsForWindow(
  chips: readonly WorkspaceChip[],
  ownerOf: (workspaceId: string) => string | undefined,
  windowId: string,
): WorkspaceChip[] {
  return chips.filter((chip) => ownerOf(chip.workspaceId) === windowId)
}
