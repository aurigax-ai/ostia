import type { ParkedItem } from '@aurigax-ai/ostia-extension-sdk'

export interface ParkedView {
  id: string
  agent: 'claude' | 'codex' | 'agy'
  title: string
  summary?: string
  folder?: string
  parkedAt: number
  tasks: number
}

export function parkedView(
  items: readonly ParkedItem[],
  tasksBySession: ReadonlyMap<string, number>,
): ParkedView[] {
  return [...items]
    .sort((a, b) => b.parkedAt - a.parkedAt)
    .map((item) => ({
      id: item.id,
      agent: item.agent,
      title: item.title,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.folder ? { folder: item.folder } : {}),
      parkedAt: item.parkedAt,
      tasks: tasksBySession.get(item.sessionId) ?? 0,
    }))
}
