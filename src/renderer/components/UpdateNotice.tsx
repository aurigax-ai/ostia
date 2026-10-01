import { ArrowClockwiseIcon, ArrowSquareOutIcon, XIcon } from '@phosphor-icons/react'
import { buildLabel } from '@shared/buildInfo'
import { fmt, useDict } from '../i18n/useDict'
import { showsUpdate, useUpdateStore } from '../stores/updateStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { Button } from './ui/button'

export function UpdateNotice(): JSX.Element | null {
  const d = useDict()
  const restartVisible = useUpdateStore(showsUpdate)
  const available = useUpdateStore((s) => s.available)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const release = useUpdateStore((s) => s.release)
  const dismissRelease = useUpdateStore((s) => s.dismissRelease)
  if (restartVisible && available) {
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
  if (!release) return null
  return (
    <output className="update-notice no-drag">
      <Hint label={d.update.releaseHint} side="bottom">
        <Button size="xs" onClick={() => void window.pine.update.openRelease()}>
          <ArrowSquareOutIcon data-icon="inline-start" aria-hidden />
          {fmt(d.update.releaseAvailable, { version: release.version })}
        </Button>
      </Hint>
      <IconButton icon={XIcon} label={d.update.dismissRelease} onClick={dismissRelease} />
    </output>
  )
}
