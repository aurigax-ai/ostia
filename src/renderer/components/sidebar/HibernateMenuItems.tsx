import { MoonIcon, SunIcon } from '@phosphor-icons/react'
import { MenuItem } from '@/components/common/Menu'
import {
  hibernatableAgentPanes,
  hibernateWorkspaces,
  resumableAgentPanes,
  resumeWorkspaces,
} from '@/lib/agents/hibernationScheduler'
import { useDict } from '@/lib/app/useDict'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHibernateSkippedStore } from '@/stores/workspaces/hibernateSkippedStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function HibernateMenuItems({ workspaceIds }: { workspaceIds: string[] }): JSX.Element {
  const d = useDict()
  useLayoutStore((s) => s.byWorkspace)
  useBlocksStore((s) => s.running)
  const sleepable = workspaceIds.some((id) => hibernatableAgentPanes(id).length > 0)
  const asleep = workspaceIds.some((id) => resumableAgentPanes(id).length > 0)
  return (
    <>
      <MenuItem
        icon={MoonIcon}
        disabled={!sleepable}
        onClick={() =>
          void hibernateWorkspaces(workspaceIds).then(useHibernateSkippedStore.getState().show)
        }
      >
        {d.rail.hibernateAgents}
      </MenuItem>
      {asleep ? (
        <MenuItem icon={SunIcon} onClick={() => resumeWorkspaces(workspaceIds)}>
          {d.rail.resumeAgents}
        </MenuItem>
      ) : null}
    </>
  )
}
