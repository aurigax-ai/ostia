import { type ChangeRef, neighborChange, orderedChanges } from '@/lib/git/changeNeighbor'
import { useEffect, useState } from 'react'

export function useDiffFileNav(
  workspaceId: string,
  path: string | undefined,
  area: ChangeRef['area'] | undefined,
): { available: boolean; go: (step: 1 | -1) => void } {
  const [changes, setChanges] = useState<ChangeRef[]>([])
  useEffect(() => {
    if (!path || !area) return
    let alive = true
    void window.ostia.git.changes(workspaceId).then((res) => {
      if (alive) setChanges(res.ok ? orderedChanges(res.data.root, res.data.changes) : [])
    })
    return () => {
      alive = false
    }
  }, [workspaceId, path, area])
  const from = path && area ? { path, area } : null
  return {
    available: from ? neighborChange(changes, from, 1) !== null : false,
    go: (step) => {
      const target = from ? neighborChange(changes, from, step) : null
      if (target) void window.ostia.git.openChange(workspaceId, target.path, target.area)
    },
  }
}
