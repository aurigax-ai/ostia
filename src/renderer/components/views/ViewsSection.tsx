import { IconButton } from '@/components/common/IconButton'
import { SectionHead, WarningNote } from '@/components/settings/SettingsPanel'
import { Highlight, useSearchGroup } from '@/components/settings/SettingsSearch'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/i18n/useDict'
import { useViewsStore } from '@/stores/extensions/viewsStore'
import { FolderOpenIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { ViewInfo } from '@shared/views/views'
import { viewIcon } from './viewIcons'

function placementLabel(d: Dict, view: ViewInfo): string | null {
  if (view.placement === 'sidebar') return d.views.placementSidebar
  if (view.placement === 'panel') return d.views.placementPanel
  return null
}

function Problems({ view }: { view: ViewInfo }): JSX.Element | null {
  const d = useDict()
  if (view.problems.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {view.stale ? (
        <WarningNote>{d.views.stale}</WarningNote>
      ) : (
        <p className="text-attn-fg text-ui-xs">{d.views.invalid}</p>
      )}
      <ul className="flex flex-col gap-0.5 rounded-sm border border-line bg-bg-sunken px-2 py-1.5 font-mono text-ui-xs">
        {view.problems.map((p, i) => (
          <li key={`${p.path}-${i}`} className="flex min-w-0 gap-2">
            <span className="shrink-0 text-fg-muted tabular-nums">
              {p.line ? fmt(d.views.line, { line: p.line }) : ''}
            </span>
            <span className="min-w-0 break-words text-fg">
              <span className="text-fg-muted">{p.path}</span> {p.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ViewRow({ view }: { view: ViewInfo }): JSX.Element {
  const d = useDict()
  const setEnabled = useViewsStore((s) => s.setEnabled)
  const Icon = viewIcon(view.icon)
  const placement = placementLabel(d, view)
  const search = useSearchGroup([view.title, view.name, view.description])
  return (
    <li
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      className="flex flex-col rounded-sm px-3 py-2"
      data-view-row={view.name}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-1 gap-2.5">
          <Icon size={14} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-fg text-ui-base">
                <Highlight text={view.title} />
              </span>
              {view.status === 'pending' ? (
                <Badge variant="outline" className="text-ui-xs">
                  {d.views.pending}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-fg-muted text-ui-xs">
              <span className="font-mono">{view.name}.json</span>
              {placement ? ` · ${placement}` : ''}
            </p>
            {view.description ? (
              <p className="mt-0.5 text-fg-muted text-ui-sm">
                <Highlight text={view.description} />
              </p>
            ) : null}
            {view.status === 'pending' ? (
              <p className="mt-0.5 text-fg-muted text-ui-xs">{d.views.pendingNote}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <IconButton
            icon={FolderOpenIcon}
            label={d.views.reveal}
            onClick={() => void window.ostia.views.reveal(view.name)}
          />
          <Switch
            checked={view.status === 'enabled'}
            disabled={view.placement === null && view.status !== 'enabled'}
            onCheckedChange={(v) => void setEnabled(view.name, v)}
            aria-label={fmt(d.views.show, { name: view.title })}
          />
        </div>
      </div>
      <Problems view={view} />
    </li>
  )
}

export function ViewsSection(): JSX.Element {
  const d = useDict()
  const dir = useViewsStore((s) => s.dir)
  const views = useViewsStore((s) => s.views)
  return (
    <section aria-label={d.views.title}>
      <SectionHead title={d.views.title} desc={fmt(d.views.desc, { dir })} />
      {views.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.views.none}</p>
      ) : (
        <ul className="-mx-3 flex flex-col">
          {views.map((view) => (
            <ViewRow key={view.name} view={view} />
          ))}
        </ul>
      )}
    </section>
  )
}
