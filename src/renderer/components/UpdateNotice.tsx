import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  type Icon as IconComponent,
  XIcon,
} from '@phosphor-icons/react'
import { fmt, useDict } from '../i18n/useDict'
import { showsUpdate, useUpdateStore } from '../stores/updateStore'
import { Hint } from './Hint'
import { Button } from './ui/button'
import { ButtonGroup, ButtonGroupSeparator } from './ui/button-group'

function NoticeGroup({
  icon: Icon,
  label,
  hint,
  onAct,
  dismissLabel,
  onDismiss,
}: {
  icon: IconComponent
  label: string
  hint: string
  onAct: () => void
  dismissLabel: string
  onDismiss: () => void
}): JSX.Element {
  return (
    <output className="update-notice no-drag">
      <ButtonGroup aria-label={label}>
        <Hint label={hint} side="bottom">
          <Button size="xs" onClick={onAct}>
            <Icon data-icon="inline-start" aria-hidden />
            {label}
          </Button>
        </Hint>
        <ButtonGroupSeparator className="bg-on-brand/25" />
        <Hint label={dismissLabel} side="bottom">
          <Button size="icon-xs" aria-label={dismissLabel} onClick={onDismiss}>
            <XIcon aria-hidden />
          </Button>
        </Hint>
      </ButtonGroup>
    </output>
  )
}

export function UpdateNotice(): JSX.Element | null {
  const d = useDict()
  const restartVisible = useUpdateStore(showsUpdate)
  const available = useUpdateStore((s) => s.available)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const release = useUpdateStore((s) => s.release)
  const dismissRelease = useUpdateStore((s) => s.dismissRelease)
  if (restartVisible && available) {
    return (
      <NoticeGroup
        icon={ArrowClockwiseIcon}
        label={d.update.restart}
        hint={fmt(d.update.body, { build: available.version })}
        onAct={() => void window.ostia.update.restart()}
        dismissLabel={d.update.later}
        onDismiss={dismiss}
      />
    )
  }
  if (!release) return null
  return (
    <NoticeGroup
      icon={ArrowSquareOutIcon}
      label={fmt(d.update.releaseAvailable, { version: release.version })}
      hint={d.update.releaseHint}
      onAct={() => void window.ostia.update.openRelease()}
      dismissLabel={d.update.dismissRelease}
      onDismiss={dismissRelease}
    />
  )
}
