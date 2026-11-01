import type { Dispatch, JSX, SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { fmt, useDict } from '@/lib/app/useDict'
import type { Editing } from './useBrowserStorage'

export function StorageEditDialog({
  editing,
  setEditing,
  onSave,
}: {
  editing: Editing | null
  setEditing: Dispatch<SetStateAction<Editing | null>>
  onSave: () => void
}): JSX.Element {
  const t = useDict().browserStorage
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) setEditing(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fmt(t.editTitle, { name: editing?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t.editDescription}</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label={t.value}
          className="max-h-64 font-mono text-ui-sm md:text-ui-sm"
          value={editing?.value ?? ''}
          spellCheck={false}
          onChange={(e) => setEditing((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
            {t.cancel}
          </Button>
          <Button size="sm" onClick={onSave}>
            {t.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function StorageClearDialog({
  open,
  setOpen,
  title,
  body,
  onConfirm,
}: {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  title: string
  body: string
  onConfirm: () => void
}): JSX.Element {
  const t = useDict().browserStorage
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t.cancel}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {t.clearConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
