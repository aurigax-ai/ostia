import { resumeConflict } from '@/lib/agents/resumeFolder'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { ResumeConflictNotice } from './ResumeFolderNotice'
import { SharedWorktreeNotice } from './SharedWorktreeNotice'

export function PaneAgentNotices({ pane }: { pane: PaneNode }): JSX.Element {
  useBlocksStore((s) => s.running)
  useBlocksStore((s) => s.agentBlocks)
  useLayoutStore((s) => s.byWorkspace)
  return resumeConflict(pane) ? (
    <ResumeConflictNotice pane={pane} />
  ) : (
    <SharedWorktreeNotice pane={pane} />
  )
}
