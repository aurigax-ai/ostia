import { resumeConflict } from '@/lib/agents/resumeFolder'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { PhoneSizeNotice } from './PhoneSizeNotice'
import { ResumeConflictNotice } from './ResumeFolderNotice'
import { SharedWorktreeNotice } from './SharedWorktreeNotice'

export function PaneAgentNotices({ pane }: { pane: PaneNode }): JSX.Element {
  useBlocksStore((s) => s.running)
  useBlocksStore((s) => s.agentBlocks)
  useLayoutStore((s) => s.byWorkspace)
  if (resumeConflict(pane)) return <ResumeConflictNotice pane={pane} />
  return (
    <div className="absolute right-0 bottom-0 left-0 z-20 flex flex-col [&>section]:static">
      <PhoneSizeNotice paneId={pane.id} />
      <SharedWorktreeNotice pane={pane} />
    </div>
  )
}
