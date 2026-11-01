import type { JSX } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { allPanes } from '@/lib/layout/tree'
import { sidebarLines } from '@/lib/sidebar/sidebarItems'
import { useCoreWatch } from '@/lib/workspaces/coreWatch'
import { latestAttentionMessage, runningTitle } from '@/lib/workspaces/workspaceSummary'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { LiveLine, LocationLine, useSidebarItems } from './RailMeta'

function WorkspaceMeta({ workspace: w }: { workspace: Workspace }): JSX.Element {
  const sidebar = useSettingsStore((s) => s.sidebar)
  const items = useSidebarItems(w.id)
  useCoreWatch('git', w.id, sidebar.showExtensionItems)
  useCoreWatch('ports', w.id, sidebar.showExtensionItems && sidebar.showSSH)
  const lines = sidebarLines(sidebar.showExtensionItems ? items : [])
  return (
    <>
      <LocationLine
        path={sidebar.showPath ? (w.projectDir ?? w.workDir) : undefined}
        items={lines.location}
        workspaceId={w.id}
      />
      <LiveLine items={lines.live} workspaceId={w.id} />
    </>
  )
}

function WorkspaceSubtitle({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId])
  const panes = layout ? allPanes(layout.root) : []
  const message = useAttentionStore((s) => latestAttentionMessage(panes, s.byPane))
  const title = useBlocksStore((s) => runningTitle(panes, layout?.activePaneId, s.running))
  const text = message ?? title
  if (!text) return null
  return <span className={`tab-subtitle${message ? ' unread' : ''}`}>{text}</span>
}

const DESCRIPTION_ELEMENTS = ['p', 'a', 'strong', 'em', 'code', 'del']

const DESCRIPTION_COMPONENTS: Components = {
  p: ({ node: _node, ...props }) => <span {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

function WorkspaceDescription({ text }: { text: string }): JSX.Element {
  return (
    <div className="tab-description">
      <Markdown
        allowedElements={DESCRIPTION_ELEMENTS}
        unwrapDisallowed
        components={DESCRIPTION_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
}

export function WorkspaceDetails({
  workspace: w,
  onSelect,
}: {
  workspace: Workspace
  onSelect: () => void
}): JSX.Element {
  const sidebar = useSettingsStore((s) => s.sidebar)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row button above is the keyboard target; this only widens the click area
    <div className="tab-after" onClick={onSelect}>
      {sidebar.showDescription && w.description ? (
        <WorkspaceDescription text={w.description} />
      ) : null}
      {sidebar.showMessage ? <WorkspaceSubtitle workspaceId={w.id} /> : null}
      <WorkspaceMeta workspace={w} />
    </div>
  )
}
