import {
  type ChordSpec,
  DOUBLE_SHIFT,
  doubleShiftDetector,
  parseChord,
  specFromEvent,
} from '@shared/keyboard/chordSpec'
import { type JSX, useEffect, useState } from 'react'
import { useDict } from '@/lib/app/useDict'
import { holdDoubleShift } from '@/lib/keyboard/chords'
import { isMac } from '@/platform'

export function ChordRecorder({
  label,
  onRecord,
  onCancel,
}: {
  label: string
  onRecord: (spec: ChordSpec) => void
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  const [doubleShift] = useState(doubleShiftDetector)
  useEffect(() => {
    const release = holdDoubleShift()
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      doubleShift.down(e, e.timeStamp)
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (e.key === 'Escape' && plain) {
        onCancel()
        return
      }
      const spec = specFromEvent(e)
      if (spec) onRecord(spec)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!doubleShift.up(e, e.timeStamp)) return
      const spec = parseChord(DOUBLE_SHIFT, isMac)
      if (spec) onRecord(spec)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      release()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [onRecord, onCancel, doubleShift])
  return (
    <output aria-label={label} aria-live="polite" className="text-fg text-ui-sm">
      {d.keyboard.recording}
    </output>
  )
}
