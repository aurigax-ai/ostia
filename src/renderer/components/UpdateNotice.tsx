import { ArrowClockwiseIcon, XIcon } from '@phosphor-icons/react'
import { buildLabel } from '@shared/buildInfo'
import { fmt, useDict } from '../i18n/useDict'
import { showsUpdate, useUpdateStore } from '../stores/updateStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { Button } from './ui/button'

export function UpdateNotice(): JSX.Element | null {
  const d = useDict()
  const visible = useUpdateStore(showsUpdate)
  const available = useUpdateStore((s) => s.available)
  const dismiss = useUpdateStore((s) => s.dismiss)
  if (!visible || !available) return null
  return (
    <output className="update-notice no-drag">
      <Hint label={fmt(d.update.body, { build: buildLabel(available) })} side="bottom">
        <Button size="xs" onClick={() => void window.pine.update.restart()}>
          <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
          {d.update.restart}
        </Button>
      </Hint>
      <IconButton icon={XIcon} label={d.update.later} onClick={dismiss} />
    </output>
  )
}
