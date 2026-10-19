import { resumeConflict } from '@/lib/agents/resumeFolder'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { PhoneSizeNotice } from './PhoneSizeNotice'
import { ResumeConflictNotice } from './ResumeFolderNotice'
import { SharedWorktreeNotice } from './SharedWorktreeNotice'

export function PaneAgentNotices({ pane }: { pane: PaneNode }): JSX.Element {
  useBlocksStore((s) => s.running)
  useBlocksStore((s) => s.agentBlocks)
  useLayoutStore((s) => s.byWorkspace)
  const phoneSized = usePhoneSizeStore((s) => pane.id in s.byPane)
  if (resumeConflict(pane)) return <ResumeConflictNotice pane={pane} />
  return phoneSized ? <PhoneSizeNotice paneId={pane.id} /> : <SharedWorktreeNotice pane={pane} />
}
