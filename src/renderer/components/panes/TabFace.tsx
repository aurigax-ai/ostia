import {
  BroadcastIcon,
  ChatCircleTextIcon,
  CoffeeIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitDiffIcon,
  GlobeIcon,
  type Icon as IconComponent,
  MoonIcon,
  RobotIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { Hint } from '@/components/common/Hint'
import { MailCount } from '@/components/common/MailCount'
import { viewIcon } from '@/components/views/viewIcons'
import { useDict } from '@/lib/app/useDict'
import { needsYou, tabMark } from '@/lib/attention/attention'
import type { PaneNode, SurfaceKind } from '@/lib/layout/types'
import { cn } from '@/lib/utils'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useViewsStore } from '@/stores/extensions/viewsStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'

const SURFACE_ICON: Record<SurfaceKind, IconComponent> = {
  terminal: TerminalWindowIcon,
  editor: FileCodeIcon,
  agent: RobotIcon,
  browser: GlobeIcon,
  diff: GitDiffIcon,
  chat: ChatCircleTextIcon,
  git: GitBranchIcon,
  view: viewIcon(undefined),
  manager: BroadcastIcon,
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
  const viewIconName = useViewsStore((s) =>
    pane.kind === 'view' ? s.views.find((v) => v.name === pane.viewName)?.icon : undefined,
  )
  const title = pane.title
  const Icon = pane.hibernated
    ? MoonIcon
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
      {pane.keepAwake ? (
        <Hint label={d.pane.keptAwake}>
          <CoffeeIcon size={16} className="pane-kind" role="img" aria-label={d.pane.keptAwake} />
        </Hint>
      ) : null}
      <MailCount paneIds={[pane.id]} />
      {diskProblem ? (
        <Hint label={diskLabel[diskProblem]}>
          <span className="pane-disk-mark" role="img" aria-label={diskLabel[diskProblem]} />
        </Hint>
      ) : null}
    </>
  )
}
