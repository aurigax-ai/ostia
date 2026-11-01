import { WarningIcon } from '@phosphor-icons/react'
import { type JSX, useEffect, useState } from 'react'
import { PromptCard } from '@/components/common/PromptCard'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { openFileInWorkspace } from '@/lib/files/openFile'

export function SettingsRecoveredNotice(): JSX.Element | null {
  const d = useDict()
  const [copy, setCopy] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.ostia.settings.recovered().then((path) => {
      if (live) setCopy(path)
    })
    return () => {
      live = false
    }
  }, [])
  if (!copy) return null
  return (
    <PromptCard
      icon={WarningIcon}
      tone="warn"
      label={d.settings.recoveredLabel}
      title={d.settings.recoveredTitle}
      dismissLabel={d.window.close}
      onDismiss={() => setCopy(null)}
      actions={
        <Button
          size="sm"
          onClick={() => {
            openFileInWorkspace(copy)
            setCopy(null)
          }}
        >
          {d.settings.recoveredOpen}
        </Button>
      }
    >
      {fmt(d.settings.recoveredBody, { path: copy })}
    </PromptCard>
  )
}
