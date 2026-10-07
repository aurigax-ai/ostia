import { XIcon } from '@phosphor-icons/react'
import type { AgentResume } from '@shared/agentResume'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import { WarningNote } from './SettingsPanel'
import { Button } from './ui/button'

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
