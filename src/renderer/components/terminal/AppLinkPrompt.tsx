import { ArrowSquareOutIcon, WarningIcon } from '@phosphor-icons/react'
import { appLinkScheme } from '@shared/common/externalLinks'
import { useState } from 'react'
import { PromptCard } from '@/components/common/PromptCard'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/lib/app/useDict'
import { confirmAppLink, dismissAppLink } from '@/lib/terminalLinks/appLinkOpen'
import type { AppLinkPromptState } from '@/stores/terminal/appLinkStore'

export function AppLinkPrompt({
  paneId,
  prompt,
}: {
  paneId: string
  prompt: AppLinkPromptState
}): JSX.Element {
  const d = useDict()
  const [always, setAlways] = useState(false)
  const scheme = `${appLinkScheme(prompt.url) ?? ''}:`
  const close = (): void => dismissAppLink(paneId)
  if (prompt.kind !== 'ask') {
    return (
      <PromptCard
        icon={WarningIcon}
        tone="warn"
        label={d.pane.appLinkLabel}
        title={
          prompt.kind === 'none'
            ? fmt(d.pane.appLinkNone, { scheme })
            : fmt(d.pane.appLinkFailed, { app: prompt.app })
        }
        dismissLabel={d.pane.appLinkCancel}
        onDismiss={close}
      >
        {prompt.kind === 'none' ? (
          d.pane.appLinkNoneBody
        ) : (
          <span className="font-mono">{prompt.url}</span>
        )}
      </PromptCard>
    )
  }
  return (
    <PromptCard
      icon={ArrowSquareOutIcon}
      label={d.pane.appLinkLabel}
      title={fmt(d.pane.appLinkTitle, { app: prompt.app })}
      dismissLabel={d.pane.appLinkCancel}
      onDismiss={close}
      actions={
        <>
          <Label className="font-normal text-fg-muted text-ui-sm sm:mr-auto">
            <Checkbox checked={always} onCheckedChange={setAlways} />
            {fmt(d.pane.appLinkDontAsk, { scheme })}
          </Label>
          <Button variant="outline" size="sm" onClick={close}>
            {d.pane.appLinkCancel}
          </Button>
          <Button
            size="sm"
            autoFocus
            onClick={() => void confirmAppLink(paneId, prompt.url, prompt.app, always)}
          >
            {d.pane.appLinkOpen}
          </Button>
        </>
      }
    >
      <span className="font-mono">{prompt.url}</span>
    </PromptCard>
  )
}
