import { isDirtyBuild } from '@shared/app/buildInfo'
import {
  isMacInstall,
  offeredChannels,
  updateChannelFor,
  updateCommandLine,
} from '@shared/app/installMethod'
import { parseVersion, type UpdateChannel } from '@shared/app/releases'
import { useEffect, useState } from 'react'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { fmt, useDict } from '@/lib/app/useDict'
import { saveSettingsNow, useSettingsStore } from '@/stores/app/settingsStore'
import { useUpdateStore } from '@/stores/app/updateStore'

const LINUX_CHANNELS = ['stable', 'beta', 'main'] as const

export function UpdateChannelPicker(): JSX.Element | null {
  const d = useDict()
  const method = useUpdateStore((s) => s.method)
  const channel = useSettingsStore((s) => s.behavior.updateChannel)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const mac = isMacInstall(method)
  const needsVersion = mac || offeredChannels(method).includes('main')
  const [running, setRunning] = useState<string | null>(null)
  useEffect(() => {
    if (!needsVersion) return
    let live = true
    window.ostia
      .info()
      .then((info) => {
        if (live) setRunning(info.version)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [needsVersion])
  if (method === 'dev') return null
  const pick = (updateChannel: UpdateChannel): void => {
    setBehavior({ updateChannel })
    void saveSettingsNow()
  }
  if (mac) {
    const beta = channel === 'beta'
    const onPrerelease = Boolean(running && parseVersion(running)?.prerelease.length)
    return (
      <ToggleRow
        label={d.update.beta}
        desc={d.update.betaDesc}
        checked={beta}
        onChange={(on) => pick(on ? 'beta' : 'stable')}
        below={
          beta && method === 'brew' ? (
            <p className="text-ui-xs text-warn-fg">
              {fmt(d.update.betaBrewNote, { command: updateCommandLine('brew') ?? '' })}
            </p>
          ) : !beta && onPrerelease && running ? (
            <p className="text-fg-muted text-ui-xs">
              {fmt(d.update.betaStays, { version: running.replace(/\+.*$/, '') })}
            </p>
          ) : undefined
        }
      />
    )
  }
  const channels = offeredChannels(method, isDirtyBuild(running ?? ''))
  const offered = channels.length > 1
  const labels: Record<(typeof LINUX_CHANNELS)[number], string> = {
    stable: d.update.channelStable,
    beta: d.update.channelBeta,
    main: d.update.channelMain,
  }
  return (
    <ControlRow
      label={d.update.channel}
      desc={offered ? d.update.channelDesc : d.update.channelStableOnly}
    >
      <SelectField
        value={updateChannelFor(method, channel, isDirtyBuild(running ?? ''))}
        onChange={pick}
        label={d.update.channel}
        disabled={!offered}
        options={channels.map((c) => ({ value: c, label: labels[c] }))}
      />
    </ControlRow>
  )
}
