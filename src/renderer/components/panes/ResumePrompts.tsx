import {
  ArrowClockwiseIcon,
  PlusIcon,
  ShieldCheckIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { AgentResume, ResumeFailure } from '@shared/agents/agentResume'
import { type JSX, useEffect, useReducer } from 'react'
import { commands } from '@/commands/registry'
import { MenuItem } from '@/components/common/Menu'
import { PromptCard } from '@/components/common/PromptCard'
import { SplitButton, SplitButtonMenu } from '@/components/common/SplitButton'
import { Button } from '@/components/ui/button'
import { alwaysTrustWorkspaceFolders, resumeAnyway, trustForClaude } from '@/lib/agents/folderTrust'
import { runningAgentOf } from '@/lib/agents/paneAgent'
import { dismissResumeFailure, retryResume, startNewSession } from '@/lib/agents/resumeFailure'
import { resumeClaimEndsAt, resumeConflict } from '@/lib/agents/resumeFolder'
import { fmt, useDict } from '@/lib/app/useDict'
import { baseName } from '@/lib/files/fileTree'
import type { PaneNode } from '@/lib/layout/types'
import type { FolderTrustKind } from '@/stores/agents/folderTrustStore'
import {
  conflictPromptKey,
  folderMissingPromptKey,
  useHiddenPromptsStore,
} from '@/stores/agents/hiddenPromptsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function FolderTrustPrompt({
  paneId,
  folder,
  kind = 'resume',
}: {
  paneId: string
  folder: string
  kind?: FolderTrustKind
}): JSX.Element {
  const d = useDict()
  const body = {
    resume: d.pane.folderTrustBody,
    start: d.pane.folderTrustStartBody,
    outside: d.pane.folderTrustOutsideBody,
  }[kind]
  return (
    <PromptCard
      icon={ShieldCheckIcon}
      label={d.pane.folderTrustLabel}
      data-folder-trust=""
      title={fmt(d.pane.folderTrustTitle, { name: baseName(folder) })}
      dismissLabel={kind === 'resume' ? d.pane.folderTrustResume : d.pane.folderTrustStartDismiss}
      onDismiss={() => resumeAnyway(paneId)}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => resumeAnyway(paneId)}>
            {d.pane.folderTrustSkip}
          </Button>
          {kind === 'outside' ? (
            <Button size="sm" onClick={() => void trustForClaude(paneId)}>
              {d.pane.folderTrustOnce}
            </Button>
          ) : (
            <SplitButton
              label={d.pane.folderTrustChoices}
              main={
                <Button size="sm" onClick={() => void trustForClaude(paneId)}>
                  {d.pane.folderTrustOnce}
                </Button>
              }
            >
              <SplitButtonMenu label={d.pane.folderTrustChoices} size="sm">
                <MenuItem onClick={() => void alwaysTrustWorkspaceFolders()}>
                  {d.pane.folderTrustAlways}
                </MenuItem>
              </SplitButtonMenu>
            </SplitButton>
          )}
        </>
      }
    >
      <span className="mb-1 block font-mono text-ui-xs">{folder}</span>
      {body}
    </PromptCard>
  )
}

export function ResumeFailedPrompt({
  paneId,
  failure,
}: {
  paneId: string
  failure: ResumeFailure
}): JSX.Element {
  const d = useDict()
  const { resume, exitCode } = failure
  return (
    <PromptCard
      icon={WarningIcon}
      tone="warn"
      label={d.pane.resumeFailedLabel}
      data-resume-failed=""
      title={d.pane.resumeFailedTitle}
      dismissLabel={d.pane.resumeFailedDismiss}
      onDismiss={() => dismissResumeFailure(paneId)}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => retryResume(paneId)}>
            <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
            {d.pane.resumeFailedRetry}
          </Button>
          <Button variant="outline" size="sm" onClick={() => startNewSession(paneId)}>
            <PlusIcon data-icon="inline-start" aria-hidden />
            {d.pane.resumeFailedNewSession}
          </Button>
        </>
      }
    >
      {fmt(d.pane.resumeFailed, {
        agent: d.agentSession[resume.agent],
        id: resume.id.slice(0, 8),
        code: exitCode,
      })}
    </PromptCard>
  )
}

function CloseTabButton({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void commands.exec('pane.close', { paneId })}
    >
      <XIcon data-icon="inline-start" aria-hidden />
      {d.pane.closeTab}
    </Button>
  )
}

export function ResumeFolderPrompt({
  paneId,
  resume,
  folder,
}: {
  paneId: string
  resume: AgentResume
  folder: string
}): JSX.Element {
  const d = useDict()
  const hide = useHiddenPromptsStore((s) => s.hide)
  return (
    <PromptCard
      icon={WarningIcon}
      tone="warn"
      label={d.pane.resumeFolderMissingLabel}
      data-resume-folder-missing=""
      title={d.pane.resumeFolderMissingTitle}
      dismissLabel={d.pane.hideNotice}
      onDismiss={() => hide(folderMissingPromptKey(paneId, folder))}
      actions={<CloseTabButton paneId={paneId} />}
    >
      {fmt(d.pane.resumeFolderMissing, { agent: resume.agent, path: folder })}
    </PromptCard>
  )
}

export function ResumeConflictPrompt({ pane }: { pane: PaneNode }): JSX.Element | null {
  const d = useDict()
  const hide = useHiddenPromptsStore((s) => s.hide)
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
    <PromptCard
      icon={WarningIcon}
      tone="warn"
      label={d.pane.resumeConflictLabel}
      data-resume-conflict=""
      title={d.pane.resumeConflictTitle}
      dismissLabel={d.pane.hideNotice}
      onDismiss={() => hide(conflictPromptKey(pane.id, holder.id))}
      actions={<CloseTabButton paneId={pane.id} />}
    >
      {fmt(both ? d.pane.resumeConflictBoth : d.pane.resumeConflict, {
        agent: pane.resume.agent,
        tab: holder.title,
      })}
    </PromptCard>
  )
}
