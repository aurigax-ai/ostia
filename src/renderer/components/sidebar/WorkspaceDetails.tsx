import type { JSX } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { rowItems } from '@/lib/sidebar/sidebarItems'
import { useCoreWatch } from '@/lib/workspaces/coreWatch'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { PathLine, useSidebarItems } from './RailMeta'
import { RowChips } from './row/RowChips'
import { RowFact } from './row/RowFact'

const DESCRIPTION_ELEMENTS = ['p', 'a', 'code']

const DESCRIPTION_COMPONENTS: Components = {
  p: ({ node: _node, ...props }) => <span {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

export function WorkspaceDescription({
  text,
  onEdit,
}: {
  text: string
  onEdit?: () => void
}): JSX.Element {
  return (
    <div className="tab-description" onDoubleClick={onEdit}>
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
  onEditDescription,
}: {
  workspace: Workspace
  onSelect: () => void
  onEditDescription: () => void
}): JSX.Element {
  const sidebar = useSettingsStore((s) => s.sidebar)
  const items = useSidebarItems(w.id)
  useCoreWatch('git', w.id, sidebar.showExtensionItems)
  useCoreWatch('ports', w.id, sidebar.showExtensionItems && sidebar.showSSH)
  const row = rowItems(sidebar.showExtensionItems ? items : [])
  const path = w.projectDir ?? w.workDir
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row button above is the keyboard target; this only widens the click area
    <div className="tab-after" onClick={onSelect}>
      {sidebar.showDescription && w.description ? (
        <WorkspaceDescription text={w.description} onEdit={onEditDescription} />
      ) : null}
      {sidebar.showPath && path ? <PathLine path={path} /> : null}
      <RowFact workspace={w} offline={row.offline} showLive={sidebar.showMessage} />
      <RowChips workspaceId={w.id} chips={row.chips} />
    </div>
  )
}
