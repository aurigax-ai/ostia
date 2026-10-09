import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { useDict } from '@/i18n/useDict'
import { useUIStore } from '@/stores/uiStore'
import { useViewsStore } from '@/stores/viewsStore'
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
  const view = useViewsStore((s) => s.views.find((v) => v.name === viewName))
  const openSettings = useUIStore((s) => s.openSettings)
  const doc = view?.status === 'enabled' && view.doc?.placement === 'panel' ? view.doc : null
  if (!view || !doc) {
    return (
      <Empty className="h-full bg-surface-1">
        <EmptyHeader>
          <EmptyDescription className="text-ui-base">{d.views.notEnabled}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => openSettings('views')}>
          {d.views.openSettings}
        </Button>
      </Empty>
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
