import { Hint } from '@/components/common/Hint'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { viewIcon } from '@/components/views/viewIcons'
import { useDict } from '@/i18n/useDict'
import type { PaneNode, SurfaceKind } from '@/layout/types'
import { needsYou, tabMark } from '@/lib/attention/attention'
import { cn } from '@/lib/utils'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useViewsStore } from '@/stores/extensions/viewsStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import {
  BroadcastIcon,
  ChatCircleTextIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitDiffIcon,
  GlobeIcon,
  type Icon as IconComponent,
  MoonIcon,
  RobotIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'

const SURFACE_ICON: Record<SurfaceKind, IconComponent> = {
  terminal: TerminalWindowIcon,
  editor: FileCodeIcon,
  agent: RobotIcon,
  browser: GlobeIcon,
  extension: extensionIcon(undefined),
  diff: GitDiffIcon,
  chat: ChatCircleTextIcon,
  git: GitBranchIcon,
  view: viewIcon(undefined),
  manager: BroadcastIcon,
}

export function usePaneTitle(pane: PaneNode): string {
  const panelTitle = useExtensionsStore((s) =>
    pane.kind === 'extension'
      ? s.list.find((e) => e.id === pane.extensionId)?.panel?.title
      : undefined,
  )
  return panelTitle ?? pane.title
}

export function usePaneMark(pane: PaneNode): ReturnType<typeof tabMark> {
  return useAttentionStore((s) => tabMark(s.byPane[pane.id]))
}

export function TabFace({
  pane,
  segment = false,
}: {
  pane: PaneNode
  segment?: boolean
}): JSX.Element {
  const d = useDict()
  const panelIcon = useExtensionsStore((s) =>
    pane.kind === 'extension'
      ? s.list.find((e) => e.id === pane.extensionId)?.panel?.icon
      : undefined,
  )
  const viewIconName = useViewsStore((s) =>
    pane.kind === 'view' ? s.views.find((v) => v.name === pane.viewName)?.icon : undefined,
  )
  const title = usePaneTitle(pane)
  const Icon = pane.hibernated
    ? MoonIcon
    : pane.kind === 'extension'
      ? extensionIcon(panelIcon)
      : pane.kind === 'view'
        ? viewIcon(viewIconName)
        : SURFACE_ICON[pane.kind]
  const dirty = useEditorStatus((s) =>
    pane.kind === 'editor' && pane.filePath ? (s.dirty[pane.filePath] ?? false) : false,
  )
  const diskProblem = useEditorStatus((s) =>
    pane.kind === 'editor' && pane.filePath ? (s.disk[pane.filePath] ?? null) : null,
  )
  const diskLabel = {
    changed: d.editor.diskMarkChanged,
    conflict: d.editor.diskMarkConflict,
    deleted: d.editor.diskMarkDeleted,
  }
  const attention = useAttentionStore((s) => s.byPane[pane.id])
  const mark = tabMark(attention)
  const loud = needsYou(attention)
  return (
    <>
      {mark ? (
        <span
          className="pane-attn-mark"
          role="img"
          aria-label={
            mark === 'waiting' || mark === 'error' ? d.attention.needsYou : d.attention.unread
          }
        />
      ) : null}
      {segment && pane.kind === 'terminal' && !pane.hibernated ? null : (
        <Icon
          key={loud ? attention?.at : undefined}
          size={16}
          className={cn('pane-kind', loud && 'pane-kind-blink')}
          aria-label={pane.hibernated ? d.pane.hibernated : undefined}
        />
      )}
      {dirty && !diskProblem ? (
        <span className="dot pane-tab-dirty" role="img" aria-label={d.pane.unsaved} />
      ) : null}
      <span className={cn('title', diskProblem === 'deleted' && 'line-through')}>{title}</span>
      {diskProblem ? (
        <Hint label={diskLabel[diskProblem]}>
          <span className="pane-disk-mark" role="img" aria-label={diskLabel[diskProblem]} />
        </Hint>
      ) : null}
    </>
  )
}
