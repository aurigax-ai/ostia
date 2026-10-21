import type { ExtensionSlots } from './extensionSlots'

export function answerInboxAction(
  slots: Pick<ExtensionSlots, 'inboxAction'>,
  ownerOf: (workspaceId: string) => string | undefined,
  senderId: string,
  extId: unknown,
  workspaceId: unknown,
  id: unknown,
): boolean {
  if (typeof extId !== 'string' || typeof workspaceId !== 'string' || typeof id !== 'string') {
    return false
  }
  if (ownerOf(workspaceId) !== senderId) return false
  return slots.inboxAction(extId, workspaceId, id)
}
