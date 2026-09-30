import { TerminalWindowIcon } from '@phosphor-icons/react'
import { useDict } from '../i18n/useDict'
import { type CloseConfirmKind, useCloseConfirmStore } from '../stores/closeConfirmStore'
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
  }
  const text = copy[pending?.kind ?? 'workspace']

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
