import { Hint } from '@/components/common/Hint'
import { RiskyPasteDialog } from '@/components/common/RiskyPasteDialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { fmt, useDict } from '@/i18n/useDict'
import { planAgentMessage, sendToAgent } from '@/lib/agentMessage'
import type { PickTarget } from '@/lib/pickTargets'
import { useSettingsStore } from '@/stores/settingsStore'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useState } from 'react'

type Outcome = { kind: 'sent' | 'refused'; agent: string }

export function AgentComposer({
  id,
  targets,
  onCancel,
}: {
  id: string
  targets: PickTarget[]
  onCancel: () => void
}): JSX.Element {
  const d = useDict()
  const [text, setText] = useState('')
  const [targetId, setTargetId] = useState<string | null>(targets[0]?.paneId ?? null)
  const [risky, setRisky] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const target = targets.find((t) => t.paneId === targetId) ?? targets[0] ?? null
  const ids = `composer-${id}`

  const deliver = (message: string): void => {
    if (!target) return
    if (sendToAgent(target.paneId, message)) {
      setText('')
      setOutcome({ kind: 'sent', agent: target.title })
      return
    }
    void navigator.clipboard?.writeText(message).catch(() => undefined)
    setOutcome({ kind: 'refused', agent: target.title })
  }

  const send = (): void => {
    const plan = planAgentMessage(text, useSettingsStore.getState().terminal.warnOnRiskyPaste)
    if (!target || !plan.text) return
    if (plan.confirm) setRisky(plan.text)
    else deliver(plan.text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }

  return (
    <section
      aria-label={d.dashboard.message}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-2"
    >
      {targets.length > 1 && target ? (
        <Select value={target.paneId} onValueChange={(value) => setTargetId(value as string)}>
          <SelectTrigger
            size="sm"
            aria-label={d.dashboard.messageTarget}
            className="w-fit max-w-full"
          >
            <span className="min-w-0 truncate">{target.title}</span>
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.paneId} value={t.paneId}>
                {t.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Label htmlFor={`${ids}-text`} className="sr-only">
        {d.dashboard.messageLabel}
      </Label>
      <Textarea
        id={`${ids}-text`}
        autoFocus
        value={text}
        placeholder={fmt(d.dashboard.messagePlaceholder, { agent: target?.title ?? '' })}
        onChange={(e) => {
          setText(e.target.value)
          setOutcome(null)
        }}
        onKeyDown={onKeyDown}
        className="min-h-9 bg-surface-1 text-ui-sm"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {outcome ? (
          <output
            className={`mr-auto text-ui-xs ${outcome.kind === 'sent' ? 'text-fg-muted' : 'text-attn-fg'}`}
          >
            {fmt(outcome.kind === 'sent' ? d.dashboard.messageSent : d.dashboard.messageRefused, {
              agent: outcome.agent,
            })}
          </output>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {d.dashboard.messageCancel}
        </Button>
        <Hint label={d.dashboard.messageSendHint}>
          <Button size="sm" disabled={!target || text.trim() === ''} onClick={send}>
            <PaperPlaneTiltIcon data-icon="inline-start" />
            {d.dashboard.messageSend}
          </Button>
        </Hint>
      </div>
      <RiskyPasteDialog
        text={risky}
        source="human"
        onPaste={(message) => {
          setRisky(null)
          deliver(message)
        }}
        onCancel={() => setRisky(null)}
      />
    </section>
  )
}
