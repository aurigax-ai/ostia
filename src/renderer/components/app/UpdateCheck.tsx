import { ArrowClockwiseIcon, ArrowSquareOutIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import type { ReleaseCheckError } from '@shared/app/releases'
import type { JSX } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { Button } from '@/components/ui/button'
import { replaceLabel } from '@/lib/app/updateProgressLabel'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { restartReady, updateAction, useUpdateStore } from '@/stores/app/updateStore'
import { UpdateChannelPicker } from './UpdateChannelPicker'

export function UpdateCheck(): JSX.Element {
  const d = useDict()
  const check = useUpdateStore((s) => s.releaseCheck)
  const pending = useUpdateStore((s) => s.release)
  const method = useUpdateStore((s) => s.method)
  const run = useUpdateStore((s) => s.updateRun)
  const ready = useUpdateStore(restartReady)
  const replace = useUpdateStore((s) => s.replace)
  const replaceRun = useUpdateStore((s) => s.replaceRun)
  const progress = useUpdateStore((s) => s.progress)
  const replaceInstall = useUpdateStore((s) => s.replaceInstall)
  const askUpdate = useUpdateStore((s) => s.askUpdate)
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates)
  const automatic = useSettingsStore((s) => s.behavior.checkForUpdates)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const errors: Record<ReleaseCheckError, string> = {
    offline: d.update.offline,
    'rate-limited': d.update.rateLimited,
    unavailable: d.update.unavailable,
  }
  const release = pending ?? (check.status === 'available' ? check.release : null)
  const action = updateAction({ release, method, replace })
  const replacing = replaceRun.status === 'downloading' || replaceRun.status === 'installing'
  const message = release
    ? fmt(d.update.releaseAvailable, { version: release.version })
    : check.status === 'latest'
      ? d.update.upToDate
      : check.status === 'error'
        ? errors[check.error]
        : ''
  const notes = (
    <>
      <output className="block text-fg-muted text-ui-sm">{message}</output>
      {run.status === 'failed' ? (
        <Notice>
          {run.exitCode === null
            ? d.update.updateStopped
            : fmt(d.update.updateFailed, { code: run.exitCode })}
        </Notice>
      ) : null}
      {replaceRun.status === 'failed' ? (
        <Notice>{d.update.replaceFailed[replaceRun.reason]}</Notice>
      ) : null}
      {release && replace && !replace.ok ? (
        <p className="text-fg-muted text-ui-xs">
          {replace.reason === 'leftover' && replace.path
            ? fmt(d.update.replaceLeftover, { path: replace.path })
            : d.update.replaceBlocked[replace.reason]}
        </p>
      ) : null}
    </>
  )
  return (
    <>
      <ControlRow label={d.update.version} desc={d.update.installedWith[method]} below={notes}>
        <Button
          variant="outline"
          size="sm"
          disabled={check.status === 'checking'}
          onClick={() => void checkForUpdates()}
        >
          {check.status === 'checking' ? d.update.checking : d.update.check}
        </Button>
        {ready ? (
          <Button size="sm" onClick={() => void window.ostia.update.restart()}>
            <ArrowClockwiseIcon data-icon="inline-start" aria-hidden />
            {d.update.restartApp}
          </Button>
        ) : action === 'replace' ? (
          <Button size="sm" disabled={replacing} onClick={() => void replaceInstall()}>
            <DownloadSimpleIcon data-icon="inline-start" aria-hidden />
            {replacing ? replaceLabel(d, replaceRun, progress) : d.update.downloadInstall}
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
      </ControlRow>
      <ToggleRow
        label={d.update.automatic}
        desc={d.update.automaticDesc}
        checked={automatic}
        onChange={(v) => setBehavior({ checkForUpdates: v })}
      />
      <UpdateChannelPicker />
    </>
  )
}
