import { FileDashedIcon, FlaskIcon, TerminalWindowIcon } from '@phosphor-icons/react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import {
  type CloseConfirmKind,
  type RunningGroup,
  useCloseConfirmStore,
} from '../stores/closeConfirmStore'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

export function CloseConfirmDialog(): JSX.Element {
  const d = useDict()
  const pending = useCloseConfirmStore((s) => s.pending)
  const answer = useCloseConfirmStore((s) => s.answer)

  const copy: Record<CloseConfirmKind, { title: string; body: string; action: string }> = {
    workspace: {
      title: d.closeConfirm.workspaceTitle,
      body: d.closeConfirm.workspaceBody,
      action: d.closeConfirm.workspaceAction,
    },
    pane: {
      title: d.closeConfirm.paneTitle,
      body: d.closeConfirm.paneBody,
      action: d.closeConfirm.paneAction,
    },
    quit: {
      title: d.closeConfirm.quitTitle,
      body: d.closeConfirm.quitBody,
      action: d.closeConfirm.quitAction,
    },
    move: {
      title: d.closeConfirm.moveTitle,
      body: d.closeConfirm.moveBody,
      action: d.closeConfirm.moveAction,
    },
  }
  const text = withScratch(d, pending?.kind ?? 'workspace', pending?.groups ?? [], copy)

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answer(false)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.body}</DialogDescription>
        </DialogHeader>
        <ul aria-label={text.title} className="flex max-h-56 flex-col gap-2 overflow-auto">
          {pending?.groups.map((group) => (
            <li key={group.workspaceId}>
              <div className="font-medium text-fg text-ui-base">{group.workspace}</div>
              <ul className="mt-1 flex flex-col gap-1">
                {group.commands.map((command, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: commands can repeat and never reorder while the dialog is open
                    key={index}
                    className="flex min-w-0 items-center gap-2 text-fg-muted"
                  >
                    <TerminalWindowIcon size={14} className="shrink-0" aria-hidden />
                    <span className="truncate font-mono text-fg text-ui-sm">
                      {command || d.closeConfirm.unknownCommand}
                    </span>
                  </li>
                ))}
                {group.scratchFiles ? (
                  <li className="flex min-w-0 items-center gap-2 text-fg-muted">
                    <FlaskIcon size={14} className="shrink-0" aria-hidden />
                    <span className="truncate text-fg text-ui-sm">
                      {group.scratchFiles === 1
                        ? d.closeConfirm.scratchFilesOne
                        : fmt(d.closeConfirm.scratchFiles, { count: group.scratchFiles })}
                    </span>
                    <Button
                      variant="link"
                      size="xs"
                      className="h-5 px-1 text-ui-sm"
                      onClick={() => window.pine.scratch.reveal(group.workspaceId)}
                    >
                      {d.closeConfirm.reveal}
                    </Button>
                  </li>
                ) : null}
                {group.files.map((file) => (
                  <li key={file} className="flex min-w-0 items-center gap-2 text-fg-muted">
                    <FileDashedIcon size={14} className="shrink-0" aria-hidden />
                    <span className="truncate text-fg text-ui-sm">
                      {fmt(d.closeConfirm.unsaved, { file: file.split('/').pop() || file })}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => answer(false)}>
            {d.closeConfirm.cancel}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => answer(true)}>
            {text.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ConfirmCopy {
  title: string
  body: string
  action: string
}

function withScratch(
  d: Dict,
  kind: CloseConfirmKind,
  groups: readonly RunningGroup[],
  copy: Record<CloseConfirmKind, ConfirmCopy>,
): ConfirmCopy {
  const count = groups.reduce((sum, g) => sum + (g.scratchFiles ?? 0), 0)
  const onlyScratch = groups.every((g) => g.commands.length === 0 && g.files.length === 0)
  if (count === 0 || !onlyScratch) return copy[kind]
  return {
    title:
      count === 1 ? d.closeConfirm.scratchTitleOne : fmt(d.closeConfirm.scratchTitle, { count }),
    body: d.closeConfirm.scratchBody,
    action: kind === 'quit' ? copy.quit.action : d.closeConfirm.scratchAction,
  }
}
