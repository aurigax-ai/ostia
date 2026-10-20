import { Notice } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
import { PaneNoticeStrip } from './PaneNoticeStrip'

export function PhoneSizeNotice({ paneId }: { paneId: string }): JSX.Element | null {
  const d = useDict()
  const sized = usePhoneSizeStore((s) => s.byPane[paneId])
  if (!sized) return null
  return (
    <PaneNoticeStrip aria-label={d.pane.phoneSizedLabel} data-phone-sized="">
      <Notice
        tone="info"
        actions={
          <Button variant="outline" size="xs" onClick={sized.useDesktop}>
            {d.pane.phoneSizedUseWindow}
          </Button>
        }
      >
        <span className="[overflow-wrap:anywhere]">
          {fmt(d.pane.phoneSized, { cols: sized.cols })}
        </span>
      </Notice>
    </PaneNoticeStrip>
  )
}
