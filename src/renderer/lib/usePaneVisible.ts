import { useEffect, useState } from 'react'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { isPaneVisible } from './workspaceActivity'

export function usePaneVisible(paneId: string): boolean {
  const [visible, setVisible] = useState(() => isPaneVisible(paneId))
  useEffect(() => {
    const update = (): void => setVisible(isPaneVisible(paneId))
    update()
    const offs = [
      useLayoutStore.subscribe(update),
      useWorkspacesStore.subscribe(update),
      useUIStore.subscribe(update),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [paneId])
  return visible
}
