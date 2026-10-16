import type { Dict } from '@shared/app/dict'
import type { ArchiveEntryProblem } from '@shared/types'

export function archiveProblemText(d: Dict, reason: ArchiveEntryProblem): string {
  if (reason === 'encrypted') return d.editor.archiveEncrypted
  if (reason === 'link') return d.editor.archiveLink
  if (reason === 'unzip-limit') return d.editor.archiveUnzipLimit
  return d.editor.archiveGone
}
