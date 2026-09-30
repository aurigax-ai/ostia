import { useDict } from '../i18n/useDict'
import { pastePreview } from '../settings/terminalPaneSettings'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'

export function RiskyPasteDialog({
  text,
  onPaste,
  onCancel,
}: {
  text: string | null
  onPaste: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <Dialog
      open={text !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{d.riskyPaste.title}</DialogTitle>
          <DialogDescription>{d.riskyPaste.desc}</DialogDescription>
        </DialogHeader>
        <pre
          aria-label={d.riskyPaste.preview}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-1 p-2 font-mono text-fg text-ui-sm"
        >
          {text === null ? '' : pastePreview(text)}
        </pre>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {d.riskyPaste.cancel}
          </Button>
          <Button size="sm" onClick={() => text !== null && onPaste(text)}>
            {d.riskyPaste.paste}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
