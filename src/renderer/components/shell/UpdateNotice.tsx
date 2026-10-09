import { Hint } from '@/components/common/Hint'
import { SplitButton } from '@/components/common/SplitButton'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/i18n/useDict'
import { replaceLabel } from '@/lib/app/replaceText'
import { restartReady, showsUpdate, updateAction, useUpdateStore } from '@/stores/updateStore'
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  DownloadSimpleIcon,
  type Icon as IconComponent,
  XIcon,
} from '@phosphor-icons/react'

function NoticeGroup({
  icon: Icon,
  label,
  hint,
  onAct,
  disabled,
  dismissLabel,
  onDismiss,
}: {
  icon: IconComponent
  label: string
  hint: string
  onAct: () => void
  disabled?: boolean
  dismissLabel: string
  onDismiss: () => void
}): JSX.Element {
  return (
    <output className="update-notice no-drag">
      <SplitButton
        label={label}
        main={
          <Hint label={hint} side="bottom">
            <Button size="xs" onClick={onAct} disabled={disabled}>
              <Icon data-icon="inline-start" aria-hidden />
              {label}
            </Button>
          </Hint>
        }
      >
        <Hint label={dismissLabel} side="bottom">
          <Button size="icon-xs" aria-label={dismissLabel} onClick={onDismiss}>
            <XIcon aria-hidden />
          </Button>
        </Hint>
      </SplitButton>
    </output>
  )
}

export function UpdateNotice(): JSX.Element | null {
  const d = useDict()
  const restartVisible = useUpdateStore(showsUpdate)
  const available = useUpdateStore((s) => s.available)
  const dismiss = useUpdateStore((s) => s.dismiss)
  const release = useUpdateStore((s) => s.release)
  const action = useUpdateStore(updateAction)
  const run = useUpdateStore((s) => s.updateRun)
  const ready = useUpdateStore(restartReady)
  const replace = useUpdateStore((s) => s.replace)
  const replaceRun = useUpdateStore((s) => s.replaceRun)
  const progress = useUpdateStore((s) => s.progress)
  const replaceInstall = useUpdateStore((s) => s.replaceInstall)
  const askUpdate = useUpdateStore((s) => s.askUpdate)
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
  if (ready) {
    return (
      <NoticeGroup
        icon={ArrowClockwiseIcon}
        label={d.update.restartApp}
        hint={d.update.restartAppHint}
        onAct={() => void window.ostia.update.restart()}
        dismissLabel={d.update.later}
        onDismiss={() => {
          const store = useUpdateStore.getState()
          store.receiveUpdateRun({ status: 'idle' })
          if (store.replaceRun.status === 'done') store.receiveReplace({ status: 'idle' })
        }}
      />
    )
  }
  if (!release || !action) return null
  if (action === 'replace') {
    const busy = replaceRun.status === 'downloading' || replaceRun.status === 'installing'
    return (
      <NoticeGroup
        icon={DownloadSimpleIcon}
        label={busy ? replaceLabel(d, replaceRun, progress) : d.update.downloadInstall}
        hint={
          replaceRun.status === 'failed'
            ? d.update.replaceFailed[replaceRun.reason]
            : fmt(d.update.releaseAvailable, { version: release.version })
        }
        onAct={() => void replaceInstall()}
        disabled={busy}
        dismissLabel={d.update.dismissRelease}
        onDismiss={dismissRelease}
      />
    )
  }
  if (action === 'release') {
    return (
      <NoticeGroup
        icon={ArrowSquareOutIcon}
        label={fmt(d.update.releaseAvailable, { version: release.version })}
        hint={
          replace && !replace.ok && replace.reason === 'leftover' && replace.path
            ? fmt(d.update.replaceLeftover, { path: replace.path })
            : d.update.releaseHint
        }
        onAct={() => void window.ostia.update.openRelease()}
        dismissLabel={d.update.dismissRelease}
        onDismiss={dismissRelease}
      />
    )
  }
  const running = run.status === 'running'
  return (
    <NoticeGroup
      icon={DownloadSimpleIcon}
      label={running ? d.update.updating : d.update.updateWith[action]}
      hint={fmt(d.update.releaseAvailable, { version: release.version })}
      onAct={askUpdate}
      disabled={running}
      dismissLabel={d.update.dismissRelease}
      onDismiss={dismissRelease}
    />
  )
}
