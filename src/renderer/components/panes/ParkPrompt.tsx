import { BookmarkSimpleIcon } from '@phosphor-icons/react'
import { PARK_NOTE_MAX } from '@shared/park/park'
import { useEffect, useRef, useState } from 'react'
import { PromptCard } from '@/components/common/PromptCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import { confirmPark } from '@/lib/park/parkTab'
import { useParkStore } from '@/stores/workspaces/parkStore'

export function ParkPrompt({ title }: { title: string }): JSX.Element {
  const d = useDict()
  const [note, setNote] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const close = useParkStore((s) => s.closePrompt)
  useEffect(() => input.current?.focus(), [])
  return (
    <PromptCard
      icon={BookmarkSimpleIcon}
      label={d.pane.parkLabel}
      data-park-prompt=""
      title={fmt(d.pane.parkTitle, { title })}
      dismissLabel={d.pane.parkCancel}
      onDismiss={close}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={close}>
            {d.pane.parkCancel}
          </Button>
          <Button size="sm" onClick={() => void confirmPark(note)}>
            {d.pane.parkConfirm}
          </Button>
        </>
      }
    >
      {d.pane.parkBody}
      <Input
        ref={input}
        value={note}
        maxLength={PARK_NOTE_MAX}
        aria-label={d.pane.parkNoteLabel}
        placeholder={d.pane.parkNotePlaceholder}
        className="mt-2 text-ui-sm"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void confirmPark(note)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      />
    </PromptCard>
  )
}
