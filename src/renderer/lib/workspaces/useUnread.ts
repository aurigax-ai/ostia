import { useState } from 'react'
import { unreadCount } from '@/lib/attention/attention'
import { paneIds } from '@/lib/layout/tree'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function useUnread(workspaceIds: string[]): { n: number; generation: number } {
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const n = useAttentionStore((s) => {
    let total = 0
    for (const id of workspaceIds) {
      const root = byWorkspace[id]?.root
      if (root) total += unreadCount(s.byPane, paneIds(root))
    }
    return total
  })
  const [seen, setSeen] = useState({ n: 0, generation: 0 })
  if (seen.n !== n) setSeen({ n, generation: n > seen.n ? seen.generation + 1 : seen.generation })
  return { n, generation: seen.generation }
}
