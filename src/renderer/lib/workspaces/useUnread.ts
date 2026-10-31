import { unreadCount } from '@/lib/attention/attention'
import { paneIds } from '@/lib/layout/tree'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function useUnread(workspaceIds: string[]): { n: number } {
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const n = useAttentionStore((s) => {
    let total = 0
    for (const id of workspaceIds) {
      const root = byWorkspace[id]?.root
      if (root) total += unreadCount(s.byPane, paneIds(root))
    }
    return total
  })
  return { n }
}
