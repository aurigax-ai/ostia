import { FolderOpenIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { ViewInfo } from '@shared/views/views'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Highlight, useSearchGroup } from '@/components/settingsKit/SettingsSearch'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/lib/app/useDict'
import { useViewsStore } from '@/stores/extensions/viewsStore'
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
        <Notice>{d.views.stale}</Notice>
      ) : (
        <p className="text-attn-fg text-ui-xs">{d.views.invalid}</p>
      )}
      <ul className="flex flex-col gap-0.5 rounded-sm border border-line bg-bg-sunken px-2 py-1.5 font-mono text-ui-xs">
        {view.problems.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the index tells repeated entries apart and the list is rebuilt, never reordered
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
    <SettingsListRow
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      data-view-row={view.name}
      lead={<Icon size={16} aria-hidden />}
      title={<Highlight text={view.title} />}
      meta={
        view.status === 'pending' ? (
          <Badge variant="outline" className="text-ui-xs">
            {d.views.pending}
          </Badge>
        ) : null
      }
      detail={
        <>
          <p className="truncate text-ui-xs">
            <span className="font-mono">{view.name}.json</span>
            {placement ? ` · ${placement}` : ''}
          </p>
          {view.description ? (
            <p>
              <Highlight text={view.description} />
            </p>
          ) : null}
          {view.status === 'pending' ? <p className="text-ui-xs">{d.views.pendingNote}</p> : null}
          <Problems view={view} />
        </>
      }
      actions={
        <>
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
        </>
      }
    />
  )
}

export function ViewsSection(): JSX.Element {
  const d = useDict()
  const dir = useViewsStore((s) => s.dir)
  const views = useViewsStore((s) => s.views)
  return (
    <SettingsPage title={d.views.title} desc={fmt(d.views.desc, { dir })}>
      <SettingsList label={d.views.title} empty={d.views.none}>
        {views.map((view) => (
          <ViewRow key={view.name} view={view} />
        ))}
      </SettingsList>
    </SettingsPage>
  )
}
