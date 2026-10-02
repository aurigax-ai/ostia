import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import {
  type CheckpointCheck,
  checkCheckpoint,
  checkpointFiles,
  restoreCheckpoint,
} from '../lib/chatCheckpoint'
import type { PineChatMessage } from '../lib/chatTransport'
import { sessionEdits } from '../stores/chatToolsStore'
import { shownPath } from './ChatEditCard'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

export function ChatCheckpointDialog({
  sessionId,
  workspaceId,
  messages,
  messageId,
  onClose,
  onDone,
}: {
  sessionId: string
  workspaceId: string | null
  messages: readonly PineChatMessage[]
  messageId: string | null
  onClose: () => void
  onDone: (text: string) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools.checkpoint
  const [checks, setChecks] = useState<CheckpointCheck[] | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    setChecks(null)
    if (!messageId) return
    let live = true
    const files = checkpointFiles(messages, sessionEdits(sessionId), messageId)
    void checkCheckpoint(files).then((result) => {
      if (live) setChecks(result)
    })
    return () => {
      live = false
    }
  }, [messageId, messages, sessionId])

  const ready = (checks ?? []).filter((c) => c.status === 'ready')
  const refused = (checks ?? []).filter((c) => c.status !== 'ready' && c.status !== 'unchanged')
  const reasonOf = (status: CheckpointCheck['status']): string =>
    (t.reasons as Record<string, string>)[status] ?? t.reasons.other

  const confirm = async (): Promise<void> => {
    setWorking(true)
    const results = await restoreCheckpoint(
      sessionId,
      ready.map((c) => c.file),
    )
    setWorking(false)
    const restored = results.filter((c) => c.status === 'ready').length
    const failed = results.length - restored + refused.length
    onDone(
      failed > 0 ? fmt(t.partial, { count: restored, failed }) : fmt(t.done, { count: restored }),
    )
    onClose()
  }

  return (
    <Dialog
      open={messageId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.body}</DialogDescription>
        </DialogHeader>
        {checks === null ? (
          <p className="text-fg-muted text-ui-sm">{t.checking}</p>
        ) : (
          <div className="flex max-h-72 flex-col gap-2 overflow-auto text-ui-sm">
            {ready.length > 0 ? (
              <div>
                <p className="text-fg">{t.restore}</p>
                <ul aria-label={t.restore} className="flex flex-col">
                  {ready.map((c) => (
                    <li key={c.file.path} className="flex gap-2">
                      <span className="truncate font-mono text-fg text-ui-xs">
                        {shownPath(c.file.path, workspaceId)}
                      </span>
                      {c.file.content === null ? (
                        <span className="shrink-0 text-fg-muted text-ui-xs">{t.deleted}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-fg-muted">{t.nothing}</p>
            )}
            {refused.length > 0 ? (
              <div>
                <p className="text-fg">{t.refused}</p>
                <ul aria-label={t.refused} className="flex flex-col">
                  {refused.map((c) => (
                    <li key={c.file.path} className="flex gap-2">
                      <span className="truncate font-mono text-fg text-ui-xs">
                        {shownPath(c.file.path, workspaceId)}
                      </span>
                      <span className="shrink-0 text-attn-fg text-ui-xs">{reasonOf(c.status)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={ready.length === 0 || working}
            onClick={() => void confirm()}
          >
            {fmt(t.confirm, { count: ready.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
