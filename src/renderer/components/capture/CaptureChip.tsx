import { CheckIcon } from '@phosphor-icons/react'
import { type JSX, useEffect, useState } from 'react'
import { CHIP_MS } from '@/lib/capture/captureSession'

const EXIT_MS = 105

export function CaptureChip({ label }: { label: string }): JSX.Element {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), CHIP_MS - EXIT_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="notice-slot" data-leaving={leaving ? '' : undefined}>
      <output
        data-testid="capture-chip"
        className="motion-enter pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto flex w-fit max-w-80 items-center gap-2 rounded-md border border-line bg-surface-3 px-2 py-1 text-fg text-ui-sm shadow-md"
      >
        <CheckIcon size={16} aria-hidden className="shrink-0" />
        <span className="truncate">{label}</span>
      </output>
    </div>
  )
}
