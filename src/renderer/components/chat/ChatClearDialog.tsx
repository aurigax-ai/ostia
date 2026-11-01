import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'

interface ChatClearDialogProps {
  confirmClear: boolean
  setConfirmClear: (open: boolean) => void
  messages: readonly OstiaChatMessage[]
  onClear: () => void
}

export function ChatClearDialog({
  confirmClear,
  setConfirmClear,
  messages,
  onClear,
}: ChatClearDialogProps): JSX.Element {
  const d = useDict()
  return (
    <Dialog
      open={confirmClear}
      onOpenChange={(open) => {
        if (!open) setConfirmClear(false)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{d.chatSlash.clearTitle}</DialogTitle>
          <DialogDescription>
            {fmt(d.chatSlash.clearBody, { count: messages.length })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)}>
            {d.chatSlash.cancel}
          </Button>
          <Button variant="destructive" size="sm" onClick={onClear}>
            {d.chatSlash.clearConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
