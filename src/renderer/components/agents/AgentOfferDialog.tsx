import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { fmt, useDict } from '@/i18n/useDict'
import { sendReference } from '@/lib/agents/sendPick'
import { useAgentOfferStore } from '@/stores/agentOfferStore'
import type { ExtensionAgentOffer } from '@shared/extensions'
import { useState } from 'react'
import { stateLabel, useAgentTargets, useNoAgentsText } from './PickSendPanel'

function OfferBody({ offer }: { offer: ExtensionAgentOffer }): JSX.Element {
  const d = useDict()
  const answer = useAgentOfferStore((s) => s.answer)
  const targets = useAgentTargets(offer.workspaceId)
  const noTargets = useNoAgentsText(offer.workspaceId)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const target = targets.find((t) => t.paneId === targetId) ?? targets[0] ?? null
  const ids = `agent-offer-${offer.requestId}`

  const send = async (): Promise<void> => {
    if (!target || sending) return
    setSending(true)
    const inserted = await sendReference({ paneId: target.paneId, via: target.via }, offer.text)
    answer(offer.requestId, inserted ? target.paneId : null)
  }

  return (
    <DialogContent showCloseButton={false} className="w-[min(90vw,40rem)] max-w-none sm:max-w-none">
      <DialogHeader>
        <DialogTitle>{fmt(d.agentOffer.title, { label: offer.label })}</DialogTitle>
        <DialogDescription>
          {fmt(d.agentOffer.body, { extension: offer.extName })}
        </DialogDescription>
      </DialogHeader>
      <pre
        aria-label={d.agentOffer.text}
        className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-surface-1 p-3 font-mono text-fg text-ui-sm"
      >
        {offer.text}
      </pre>
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-fg-muted text-ui-xs">{d.send.target}</legend>
        {targets.length === 0 ? (
          <p className="text-fg-muted text-ui-sm">{noTargets}</p>
        ) : (
          <RadioGroup
            aria-label={d.send.target}
            value={target?.paneId ?? null}
            onValueChange={(value) => setTargetId(value as string)}
            className="flex max-h-48 flex-col gap-0 overflow-y-auto"
          >
            {targets.map((t) => (
              <label
                key={t.paneId}
                htmlFor={`${ids}-${t.paneId}`}
                className="flex items-center gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2 has-data-checked:bg-surface-2"
              >
                <RadioGroupItem id={`${ids}-${t.paneId}`} value={t.paneId} />
                <span
                  className={`dot ${t.state === 'none' ? '' : t.state}`}
                  role="img"
                  aria-label={stateLabel(d, t.state)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{t.title}</span>
                  {t.cwd ? (
                    <span className="truncate font-mono text-fg-muted text-ui-xs">{t.cwd}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
      </fieldset>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => answer(offer.requestId, null)}>
          {d.agentOffer.cancel}
        </Button>
        <Button size="sm" disabled={!target || sending} onClick={() => void send()}>
          {d.send.send}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function AgentOfferDialog(): JSX.Element {
  const offer = useAgentOfferStore((s) => s.offers[0] ?? null)
  const answer = useAgentOfferStore((s) => s.answer)
  return (
    <Dialog
      open={offer !== null}
      onOpenChange={(open) => {
        if (!open && offer) answer(offer.requestId, null)
      }}
    >
      {offer ? <OfferBody key={offer.requestId} offer={offer} /> : null}
    </Dialog>
  )
}
