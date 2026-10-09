import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/i18n/useDict'
import { type PasteSource, countLines, pastePreview } from '@/lib/pasteGate'
import { useSettingsStore } from '@/stores/settingsStore'
import { useEffect, useRef, useState } from 'react'

export function RiskyPasteDialog({
  text,
  source,
  onPaste,
  onCancel,
}: {
  text: string | null
  source: PasteSource
  onPaste: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  const pasteButton = useRef<HTMLButtonElement>(null)
  const [dontAsk, setDontAsk] = useState(false)
  useEffect(() => {
    if (text !== null) setDontAsk(false)
  }, [text])
  const lines = text === null ? 0 : countLines(text)
  const chars = text?.length ?? 0
  const preview = text === null ? null : pastePreview(text)
  const paste = (): void => {
    if (text === null) return
    if (source === 'human' && dontAsk) {
      useSettingsStore.getState().setTerminal({ warnOnRiskyPaste: false })
    }
    onPaste(text)
  }
  return (
    <Dialog
      open={text !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={pasteButton}
        className="w-[min(90vw,56rem)] max-w-none sm:max-w-none"
      >
        <DialogHeader>
          <DialogTitle>{d.riskyPaste.title}</DialogTitle>
          <DialogDescription>
            {lines > 1 ? fmt(d.riskyPaste.descLines, { lines }) : d.riskyPaste.descControl}
          </DialogDescription>
        </DialogHeader>
        <pre
          aria-label={d.riskyPaste.preview}
          className="max-h-[min(60vh,32rem)] min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-1 p-3 font-mono text-fg text-ui-sm"
        >
          {preview?.parts.map((part) =>
            part.control ? (
              <span
                key={part.offset}
                data-control=""
                className="rounded-xs bg-surface-2 px-0.5 text-fg-muted"
              >
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )}
        </pre>
        <p className="text-fg-muted text-ui-xs">
          {lines > 1
            ? fmt(d.riskyPaste.sizeLines, { lines, chars })
            : fmt(d.riskyPaste.sizeChars, { chars })}
          {preview?.truncated ? ` · ${d.riskyPaste.truncated}` : ''}
        </p>
        <DialogFooter className="sm:items-center">
          {source === 'human' ? (
            <Label className="font-normal text-fg-muted text-ui-sm sm:mr-auto">
              <Checkbox checked={dontAsk} onCheckedChange={setDontAsk} />
              {d.riskyPaste.dontAsk}
            </Label>
          ) : null}
          <Button variant="outline" size="sm" onClick={onCancel}>
            {d.riskyPaste.cancel}
          </Button>
          <Button ref={pasteButton} size="sm" onClick={paste}>
            {d.riskyPaste.paste}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
