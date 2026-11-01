import type { JSX } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useUIStore } from '@/stores/app/uiStore'
import { useViewsStore } from '@/stores/extensions/viewsStore'
import { DeclarativeView } from './DeclarativeView'

export function ViewSurface({
  paneId,
  workspaceId,
  viewName,
}: {
  paneId: string
  workspaceId: string
  viewName: string
}): JSX.Element {
  const d = useDict()
  useSurfaceFocus(paneId, null)
  const view = useViewsStore((s) => s.views.find((v) => v.name === viewName))
  const openSettings = useUIStore((s) => s.openSettings)
  const doc = view?.status === 'enabled' && view.doc?.placement === 'panel' ? view.doc : null
  if (!view || !doc) {
    return (
      <EmptyState variant="surface" className="h-full bg-surface-1" desc={d.views.notEnabled}>
        <Button variant="outline" size="sm" onClick={() => openSettings('views')}>
          {d.views.openSettings}
        </Button>
      </EmptyState>
    )
  }
  return (
    <div className="h-full min-h-0 overflow-auto bg-surface-1">
      <div className="mx-auto max-w-[760px] px-5 py-4">
        <DeclarativeView
          view={{ ...view, doc }}
          density="pane"
          paneId={paneId}
          workspaceId={workspaceId}
        />
      </div>
    </div>
  )
}
