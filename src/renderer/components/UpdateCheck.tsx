import { ArrowClockwiseIcon, ArrowSquareOutIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import type { ReleaseCheckError } from '@shared/releases'
import { fmt, useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { updateAction, useUpdateStore } from '../stores/updateStore'
import { ToggleRow } from './SettingsPanel'
import { Button } from './ui/button'

export function UpdateCheck(): JSX.Element {
  const d = useDict()
  const check = useUpdateStore((s) => s.releaseCheck)
  const pending = useUpdateStore((s) => s.release)
  const method = useUpdateStore((s) => s.method)
  const run = useUpdateStore((s) => s.updateRun)
  const askUpdate = useUpdateStore((s) => s.askUpdate)
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates)
  const automatic = useSettingsStore((s) => s.behavior.checkForUpdates)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const errors: Record<ReleaseCheckError, string> = {
    offline: d.update.offline,
    'rate-limited': d.update.rateLimited,
    unavailable: d.update.unavailable,
  }
  const release =
    check.status === 'available' ? check.release : check.status === 'idle' ? pending : null
  const action = updateAction({ release, method })
  const message = release
    ? fmt(d.update.releaseAvailable, { version: release.version })
    : check.status === 'latest'
      ? d.update.upToDate
      : check.status === 'error'
        ? errors[check.error]
        : ''
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <p className="text-fg-muted text-ui-xs">{d.update.installedWith[method]}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={check.status === 'checking'}
        onClick={() => void checkForUpdates()}
      >
        {check.status === 'checking' ? d.update.checking : d.update.check}
      </Button>
      <output className="text-fg-muted text-ui-sm">{message}</output>
      {run.status === 'failed' ? (
        <p className="text-ui-sm text-warn-fg">
          {run.exitCode === null
            ? d.update.updateStopped
            : fmt(d.update.updateFailed, { code: run.exitCode })}
        </p>
      ) : null}
      {run.status === 'done' ? (
        <Button size="sm" onClick={() => void window.ostia.update.restart()}>
          <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
          {d.update.restartApp}
        </Button>
      ) : action === 'apt' || action === 'brew' ? (
        <Button size="sm" disabled={run.status === 'running'} onClick={askUpdate}>
          <DownloadSimpleIcon data-icon="inline-start" aria-hidden />
          {run.status === 'running' ? d.update.updating : d.update.updateWith[action]}
        </Button>
      ) : null}
      {release ? (
        <Button
          variant={action === 'release' ? 'default' : 'outline'}
          size="sm"
          onClick={() => void window.ostia.update.openRelease()}
        >
          <ArrowSquareOutIcon data-icon="inline-start" aria-hidden />
          {d.update.viewRelease}
        </Button>
      ) : null}
      <div className="mt-4 w-full max-w-md text-left">
        <ToggleRow
          label={d.update.automatic}
          desc={d.update.automaticDesc}
          checked={automatic}
          onChange={(v) => setBehavior({ checkForUpdates: v })}
        />
      </div>
    </div>
  )
}
