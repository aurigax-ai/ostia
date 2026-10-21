import type { PickCapture } from '@shared/browser/pick'
import type { RegionCapture } from '@shared/browser/regionCapture'
import { PickSendPanel } from '@/components/agents/PickSendPanel'
import { NoticeSlot } from '@/components/common/NoticeSlot'
import { StatusLine } from '@/components/common/StatusLine'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { fmt, useDict } from '@/lib/app/useDict'

interface BrowserCaptureBarProps {
  picking: { byAgent: boolean } | null
  cropping: boolean
  status: string | null
  capture: PickCapture | null
  setCapture: (next: PickCapture | null) => void
  region: RegionCapture | null
  setRegion: (next: RegionCapture | null) => void
  targets: PickTarget[]
  noTargets: string
  sending: boolean
  send: (target: PickTarget, note: string) => Promise<void>
  copyRegion: () => Promise<void>
}

export function BrowserCaptureBar({
  picking,
  cropping,
  status,
  capture,
  setCapture,
  region,
  setRegion,
  targets,
  noTargets,
  sending,
  send,
  copyRegion,
}: BrowserCaptureBarProps): JSX.Element {
  const d = useDict()
  return (
    <>
      {picking || cropping || status ? (
        <StatusLine>
          {picking
            ? picking.byAgent
              ? d.browser.pickHintAgent
              : d.browser.pickHint
            : cropping
              ? d.browser.regionHint
              : status}
        </StatusLine>
      ) : null}
      <NoticeSlot>
        {capture ? (
          <PickSendPanel
            id={capture.id}
            summary={capture.label || capture.selector}
            noteLabel={d.browser.note}
            notePlaceholder={d.browser.notePlaceholder}
            closeLabel={d.browser.closeSend}
            targets={targets}
            noTargets={noTargets}
            sending={sending}
            onSend={(target, note) => void send(target, note)}
            onClose={() => setCapture(null)}
          />
        ) : null}
      </NoticeSlot>
      <NoticeSlot>
        {region ? (
          <PickSendPanel
            id={region.id}
            summary={fmt(d.browser.regionSummary, {
              width: region.rect.width,
              height: region.rect.height,
              page: region.title || region.url,
            })}
            noteLabel={d.browser.note}
            notePlaceholder={d.browser.notePlaceholder}
            closeLabel={d.browser.closeSend}
            targets={targets}
            noTargets={noTargets}
            sending={sending}
            onSend={(target, note) => void send(target, note)}
            onClose={() => setRegion(null)}
            secondary={{ label: d.browser.copyImage, onClick: () => void copyRegion() }}
          />
        ) : null}
      </NoticeSlot>
    </>
  )
}
