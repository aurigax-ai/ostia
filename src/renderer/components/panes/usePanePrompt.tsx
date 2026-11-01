import { type JSX, useEffect } from 'react'
import { ApprovalPrompt } from '@/components/agents/ApprovalCard'
import { QuestionPrompt } from '@/components/agents/QuestionCard'
import { AppLinkPrompt } from '@/components/terminal/AppLinkPrompt'
import { resumeConflict } from '@/lib/agents/resumeFolder'
import type { PaneNode } from '@/lib/layout/types'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import {
  approvalPromptKey,
  conflictPrefix,
  conflictPromptKey,
  folderMissingPrefix,
  folderMissingPromptKey,
  questionPromptKey,
  useHiddenPromptsStore,
} from '@/stores/agents/hiddenPromptsStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useAppLinkStore } from '@/stores/terminal/appLinkStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import {
  FolderTrustPrompt,
  ResumeConflictPrompt,
  ResumeFailedPrompt,
  ResumeFolderPrompt,
} from './ResumePrompts'

export function usePanePrompt(pane: PaneNode): JSX.Element | null {
  const hidden = useHiddenPromptsStore((s) => s.hidden)
  const forget = useHiddenPromptsStore((s) => s.forget)
  const approval = useApprovalsStore((s) =>
    s.pending.find((r) => r.paneId === pane.id && !hidden[approvalPromptKey(r.id)]),
  )
  const question = useQuestionsStore((s) =>
    s.pending.find((q) => q.paneId === pane.id && !hidden[questionPromptKey(q.id)]),
  )
  const appLink = useAppLinkStore((s) => s.byPane[pane.id])
  const trustFolder = useFolderTrustStore((s) => s.byPane[pane.id])
  useBlocksStore((s) => s.running)
  useBlocksStore((s) => s.agentBlocks)
  useLayoutStore((s) => s.byWorkspace)
  const holder = resumeConflict(pane)
  const folderMissing = Boolean(pane.resumeFolderMissing && pane.resume)
  useEffect(() => {
    if (!holder) forget(conflictPrefix(pane.id))
    if (!folderMissing) forget(folderMissingPrefix(pane.id))
  }, [holder, folderMissing, forget, pane.id])
  if (appLink) return <AppLinkPrompt paneId={pane.id} prompt={appLink} />
  if (approval) return <ApprovalPrompt request={approval} paneTitle={pane.title} />
  if (question) return <QuestionPrompt question={question} />
  if (trustFolder)
    return (
      <FolderTrustPrompt paneId={pane.id} folder={trustFolder.folder} kind={trustFolder.kind} />
    )
  if (pane.resumeFailed) return <ResumeFailedPrompt paneId={pane.id} failure={pane.resumeFailed} />
  if (
    pane.resumeFolderMissing &&
    pane.resume &&
    !hidden[folderMissingPromptKey(pane.id, pane.resumeFolderMissing)]
  ) {
    return (
      <ResumeFolderPrompt paneId={pane.id} resume={pane.resume} folder={pane.resumeFolderMissing} />
    )
  }
  if (holder && !hidden[conflictPromptKey(pane.id, holder.id)]) {
    return <ResumeConflictPrompt pane={pane} />
  }
  return null
}
