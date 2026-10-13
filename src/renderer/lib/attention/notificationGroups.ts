import type { NotificationEntry, NotificationKind } from '@shared/types'

export const NOTIFICATION_TABS = ['all', 'needs', 'done', 'messages'] as const
export type NotificationTab = (typeof NOTIFICATION_TABS)[number]

const TAB_KINDS: Record<Exclude<NotificationTab, 'all'>, readonly NotificationKind[]> = {
  needs: ['waiting', 'approval', 'error'],
  done: ['done'],
  messages: ['message'],
}

export function inTab(entry: NotificationEntry, tab: NotificationTab): boolean {
  return tab === 'all' || TAB_KINDS[tab].includes(entry.kind)
}

export interface NotificationGroup {
  key: string
  label: string
  entries: NotificationEntry[]
}

export function groupNotifications(
  entries: readonly NotificationEntry[],
  groupOf: (entry: NotificationEntry) => { key: string; label: string },
): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>()
  for (const entry of entries) {
    const { key, label } = groupOf(entry)
    const group = groups.get(key) ?? { key, label, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  return [...groups.values()]
}
