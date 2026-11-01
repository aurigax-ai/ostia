import { type JSX, useState } from 'react'
import { StatusAction, StatusLine } from '@/components/common/StatusLine'
import { fmt, useDict } from '@/lib/app/useDict'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'

export function usePhoneSizeStatus(paneId: string): JSX.Element | null {
  const d = useDict()
  const sized = usePhoneSizeStore((s) => s.byPane[paneId])
  const [dismissed, setDismissed] = useState<unknown>(null)
  if (!sized || dismissed === sized) return null
  return (
    <div className="absolute inset-x-0 top-0 z-20">
      <StatusLine
        data-phone-sized=""
        aria-label={d.pane.phoneSizedLabel}
        actions={
          <StatusAction onClick={sized.useDesktop}>{d.pane.phoneSizedUseWindow}</StatusAction>
        }
        onDismiss={() => setDismissed(sized)}
      >
        {fmt(d.pane.phoneSized, { cols: sized.cols })}
      </StatusLine>
    </div>
  )
}
