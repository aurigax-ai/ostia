import { commands } from '@/commands/registry'
import { Notice } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import { alwaysTrustWorkspaceFolders, resumeAnyway, trustForClaude } from '@/lib/agents/folderTrust'
import { runningAgentOf } from '@/lib/agents/paneAgent'
import { dismissResumeFailure, retryResume, startNewSession } from '@/lib/agents/resumeFailure'
import { resumeClaimEndsAt, resumeConflict } from '@/lib/agents/resumeFolder'
import { fmt, useDict } from '@/lib/app/useDict'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { ArrowClockwiseIcon, PlusIcon, XIcon } from '@phosphor-icons/react'
import type { ResumeFailure } from '@shared/agents/agentResume'
import type { AgentResume } from '@shared/agents/agentResume'
import { useEffect, useReducer } from 'react'
import { PaneNoticeStrip } from './PaneNoticeStrip'

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
    <PaneNoticeStrip aria-label={d.pane.resumeFolderMissingLabel} data-resume-folder-missing="">
      <Notice
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
      </Notice>
    </PaneNoticeStrip>
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
    <PaneNoticeStrip aria-label={d.pane.resumeConflictLabel} data-resume-conflict="">
      <Notice
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
      </Notice>
    </PaneNoticeStrip>
  )
}

export function ResumeFailedNotice({
  paneId,
  failure,
}: {
  paneId: string
  failure: ResumeFailure
}): JSX.Element {
  const d = useDict()
  const { resume, exitCode } = failure
  return (
    <PaneNoticeStrip aria-label={d.pane.resumeFailedLabel} data-resume-failed="">
      <Notice
        actions={
          <>
            <Button variant="outline" size="xs" onClick={() => retryResume(paneId)}>
              <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
              {d.pane.resumeFailedRetry}
            </Button>
            <Button variant="outline" size="xs" onClick={() => startNewSession(paneId)}>
              <PlusIcon data-icon="inline-start" aria-hidden />
              {d.pane.resumeFailedNewSession}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => dismissResumeFailure(paneId)}>
              {d.pane.resumeFailedDismiss}
            </Button>
          </>
        }
      >
        <span className="[overflow-wrap:anywhere]">
          {fmt(d.pane.resumeFailed, {
            agent: d.agentSession[resume.agent],
            id: resume.id.slice(0, 8),
            code: exitCode,
          })}
        </span>
      </Notice>
    </PaneNoticeStrip>
  )
}

export function FolderTrustNotice({
  paneId,
  folder,
}: {
  paneId: string
  folder: string
}): JSX.Element {
  const d = useDict()
  return (
    <PaneNoticeStrip aria-label={d.pane.folderTrustLabel} data-folder-trust="">
      <Notice
        actions={
          <>
            <Button variant="outline" size="xs" onClick={() => void trustForClaude(paneId)}>
              {d.pane.folderTrustOnce}
            </Button>
            <Button variant="outline" size="xs" onClick={() => void alwaysTrustWorkspaceFolders()}>
              {d.pane.folderTrustAlways}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => resumeAnyway(paneId)}>
              {d.pane.folderTrustSkip}
            </Button>
          </>
        }
      >
        <span className="[overflow-wrap:anywhere]">
          {fmt(d.pane.folderTrust, { path: folder })}
        </span>
      </Notice>
    </PaneNoticeStrip>
  )
}
