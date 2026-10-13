import { ControlRow, SelectField, ToggleRow } from '@/components/settings/SettingsPanel'
import { fmt, useDict } from '@/i18n/useDict'
import { saveSettingsNow, useSettingsStore } from '@/stores/app/settingsStore'
import { useUpdateStore } from '@/stores/app/updateStore'
import { isMacInstall, offeredChannels, updateCommandLine } from '@shared/app/installMethod'
import type { UpdateChannel } from '@shared/app/releases'

const LINUX_CHANNELS = ['stable', 'main'] as const

export function UpdateChannelPicker(): JSX.Element | null {
  const d = useDict()
  const method = useUpdateStore((s) => s.method)
  const channel = useSettingsStore((s) => s.behavior.updateChannel)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  if (method === 'dev') return null
  const pick = (updateChannel: UpdateChannel): void => {
    useUpdateStore.setState({ releaseCheck: { status: 'idle' } })
    setBehavior({ updateChannel })
    void saveSettingsNow()
  }
  if (isMacInstall(method)) {
    const beta = channel === 'beta'
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
          ) : undefined
        }
      />
    )
  }
  const offered = offeredChannels(method).includes('main')
  const labels: Record<(typeof LINUX_CHANNELS)[number], string> = {
    stable: d.update.channelStable,
    main: d.update.channelMain,
  }
  return (
    <ControlRow
      label={d.update.channel}
      desc={offered ? d.update.channelDesc : d.update.channelStableOnly}
    >
      <SelectField
        value={offered && channel === 'main' ? 'main' : 'stable'}
        onChange={pick}
        label={d.update.channel}
        disabled={!offered}
        options={LINUX_CHANNELS.map((c) => ({ value: c, label: labels[c] }))}
      />
    </ControlRow>
  )
}
