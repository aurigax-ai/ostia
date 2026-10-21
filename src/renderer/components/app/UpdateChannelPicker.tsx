import { isMacInstall, offeredChannels, updateCommandLine } from '@shared/app/installMethod'
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
  const [running, setRunning] = useState<string | null>(null)
  useEffect(() => {
    if (!mac) return
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
  }, [mac])
  if (method === 'dev') return null
  const pick = (updateChannel: UpdateChannel): void => {
    useUpdateStore.setState({ releaseCheck: { status: 'idle' } })
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
  const offered = offeredChannels(method).length > 1
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
        value={offered && channel !== 'stable' ? channel : 'stable'}
        onChange={pick}
        label={d.update.channel}
        disabled={!offered}
        options={LINUX_CHANNELS.map((c) => ({ value: c, label: labels[c] }))}
      />
    </ControlRow>
  )
}
