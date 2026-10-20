import { resumeConflict } from '@/lib/agents/resumeFolder'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { PhoneSizeNotice } from './PhoneSizeNotice'
import { ResumeConflictNotice } from './ResumeFolderNotice'

export function PaneAgentNotices({ pane }: { pane: PaneNode }): JSX.Element {
  useBlocksStore((s) => s.running)
  useBlocksStore((s) => s.agentBlocks)
  useLayoutStore((s) => s.byWorkspace)
  return (
    <div className="absolute right-0 bottom-0 left-0 z-20 flex flex-col [&>section]:static">
      <PhoneSizeNotice paneId={pane.id} />
      {resumeConflict(pane) ? <ResumeConflictNotice pane={pane} /> : null}
    </div>
  )
}
