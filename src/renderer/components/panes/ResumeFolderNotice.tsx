import { commands } from '@/commands/registry'
import { WarningNote } from '@/components/settings/ControlRow'
import { Button } from '@/components/ui/button'
import { runningAgentOf } from '@/lib/agents/paneAgent'
import { resumeClaimEndsAt, resumeConflict } from '@/lib/agents/resumeFolder'
import { fmt, useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { XIcon } from '@phosphor-icons/react'
import type { AgentResume } from '@shared/agents/agentResume'
import { useEffect, useReducer } from 'react'

export function ResumeFolderNotice({
  paneId,
  resume,
  folder,
}: {
  paneId: string
  resume: AgentResume
  folder: string
}): JSX.Element {
  const d = useDict()
  return (
    <section
      aria-label={d.pane.resumeFolderMissingLabel}
      data-resume-folder-missing=""
      className="motion-enter absolute right-0 bottom-0 left-0 z-20 border-line border-t bg-surface-1 px-2 pb-1.5"
    >
      <WarningNote
        actions={
          <Button
            variant="outline"
            size="xs"
            onClick={() => void commands.exec('pane.close', { paneId })}
          >
            <XIcon data-icon="inline-start" aria-hidden />
            {d.pane.closeTab}
          </Button>
        }
      >
        <span className="[overflow-wrap:anywhere]">
          {fmt(d.pane.resumeFolderMissing, { agent: resume.agent, path: folder })}
        </span>
      </WarningNote>
    </section>
  )
}

export function ResumeConflictNotice({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  useBlocksStore((s) => s.running)
  useBlocksStore((s) => s.agentBlocks)
  useLayoutStore((s) => s.byWorkspace)
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const holder = resumeConflict(pane)
  const claimEndsAt = holder ? resumeClaimEndsAt(holder.id) : null
  useEffect(() => {
    if (claimEndsAt === null) return
    const timer = setTimeout(refresh, Math.max(0, claimEndsAt - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [claimEndsAt])
  if (!holder || !pane.resume) return null
  const both = runningAgentOf(pane.id) === pane.resume.agent
  return (
    <section
      aria-label={d.pane.resumeConflictLabel}
      data-resume-conflict=""
      className="motion-enter absolute right-0 bottom-0 left-0 z-20 border-line border-t bg-surface-1 px-2 pb-1.5"
    >
      <WarningNote
        actions={
          <Button
            variant="outline"
            size="xs"
            onClick={() => void commands.exec('pane.close', { paneId: pane.id })}
          >
            <XIcon data-icon="inline-start" aria-hidden />
            {d.pane.closeTab}
          </Button>
        }
      >
        <span className="[overflow-wrap:anywhere]">
          {fmt(both ? d.pane.resumeConflictBoth : d.pane.resumeConflict, {
            agent: pane.resume.agent,
            tab: holder.title,
          })}
        </span>
      </WarningNote>
    </section>
  )
}
