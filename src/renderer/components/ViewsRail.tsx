import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'
import { fmt, useDict } from '../i18n/useDict'
import { enabledViews, useViewsStore } from '../stores/viewsStore'
import { DeclarativeView, type RenderableView } from './DeclarativeView'
import { viewIcon } from './viewIcons'

function RailView({ view }: { view: RenderableView }): JSX.Element {
  const d = useDict()
  const collapsed = useViewsStore((s) => s.collapsed[view.name] ?? false)
  const toggle = useViewsStore((s) => s.toggleCollapsed)
  const Caret = collapsed ? CaretRightIcon : CaretDownIcon
  const Icon = viewIcon(view.doc.icon)
  const bodyId = `rail-view-${view.name}`
  return (
    <section className="rail-view" aria-label={view.title}>
      <button
        type="button"
        className="rail-view-head"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        aria-label={fmt(collapsed ? d.views.expand : d.views.collapse, { title: view.title })}
        onClick={() => toggle(view.name)}
      >
        <Caret size={12} className="rail-view-caret" aria-hidden />
        <Icon size={12} aria-hidden />
        <span className="rail-view-title">{view.title}</span>
      </button>
      {collapsed ? null : (
        <div id={bodyId} className="rail-view-body">
          <DeclarativeView view={view} density="rail" paneId={null} />
        </div>
      )}
    </section>
  )
}

export function ViewsRail(): JSX.Element | null {
  const views = useViewsStore((s) => s.views)
  const shown = enabledViews(views, 'sidebar')
  if (shown.length === 0) return null
  return (
    <div className="rail-views">
      {shown.map((view) =>
        view.doc ? <RailView key={view.name} view={{ ...view, doc: view.doc }} /> : null,
      )}
    </div>
  )
}
