import type { MailItem, MailMap } from '@shared/agents/mailApi'
import { create } from 'zustand'

interface MailState {
  byPane: MailMap
  apply: (map: MailMap) => void
}

export const useMailStore = create<MailState>((set) => ({
  byPane: {},
  apply: (byPane) => set({ byPane }),
}))

export function startMail(): () => void {
  const off = window.ostia.mail.onChange((map) => useMailStore.getState().apply(map))
  void window.ostia.mail.snapshot().then((map) => useMailStore.getState().apply(map))
  return off
}

export function itemsOf(map: MailMap, paneIds: readonly string[]): MailItem[] {
  return paneIds.flatMap((id) => map[id] ?? [])
}
