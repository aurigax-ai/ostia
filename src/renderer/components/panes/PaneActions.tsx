import {
  GlobeIcon,
  SquareSplitHorizontalIcon,
  SquareSplitVerticalIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { commands } from '@/commands/registry'
import { AgentForkButton } from '@/components/agents/AgentForkButton'
import { AgentSessionButton } from '@/components/agents/AgentSessionButton'
import { IconButton } from '@/components/common/IconButton'
import { ArtifactVersionsButton } from '@/components/editor/ArtifactVersions'
import { PortableActions } from '@/components/editor/PortableActions'
import { useDict } from '@/lib/app/useDict'
import type { PaneNode, SurfaceKind } from '@/lib/layout/types'
import { PaneHeaderActions } from './PaneTabMenu'

const SERVICE_SURFACES: ReadonlySet<SurfaceKind> = new Set(['chat', 'agent', 'git', 'view'])

export function PaneActions({
  pane: shown,
  workspaceId,
}: {
  pane: PaneNode
  workspaceId: string
}): JSX.Element {
  const d = useDict()
  return (
    <div className="pane-actions">
      {shown.kind === 'editor' && shown.filePath ? (
        <>
          <ArtifactVersionsButton
            workspaceId={workspaceId}
            paneId={shown.id}
            filePath={shown.filePath}
          />
          <PortableActions workspaceId={workspaceId} filePath={shown.filePath} />
        </>
      ) : null}
      <AgentSessionButton pane={shown} />
      <AgentForkButton pane={shown} workspaceId={workspaceId} />
      <PaneHeaderActions pane={shown} />
      {SERVICE_SURFACES.has(shown.kind) ? null : (
        <>
          <IconButton
            icon={TerminalWindowIcon}
            label={d.pane.newTab}
            command="tab.new"
            onClick={() => commands.exec('tab.new', { paneId: shown.id })}
          />
          <IconButton
            icon={GlobeIcon}
            label={d.pane.newBrowserTab}
            onClick={() => commands.exec('tab.newBrowser', { paneId: shown.id })}
          />
          <IconButton
            icon={SquareSplitHorizontalIcon}
            label={d.pane.splitRight}
            command="pane.splitRight"
            onClick={() =>
              commands.exec('pane.split', { paneId: shown.id, direction: 'horizontal' })
            }
          />
          <IconButton
            icon={SquareSplitVerticalIcon}
            label={d.pane.splitDown}
            command="pane.splitDown"
            onClick={() => commands.exec('pane.split', { paneId: shown.id, direction: 'vertical' })}
          />
        </>
      )}
    </div>
  )
}
