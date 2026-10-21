import type { InboxEntry, InboxItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { create } from 'zustand'

interface InboxStoreState {
  entries: InboxEntry[]
  setEntries: (entries: InboxEntry[]) => void
}

const NO_ITEMS: InboxItem[] = []

export const useInboxStore = create<InboxStoreState>((set) => ({
  entries: [],
  setEntries: (entries) => set({ entries }),
}))

export function inboxItemsOf(
  entries: readonly InboxEntry[],
  extId: string,
  workspaceId: string,
): InboxItem[] {
  return (
    entries.find((entry) => entry.extId === extId && entry.workspaceId === workspaceId)?.items ??
    NO_ITEMS
  )
}
