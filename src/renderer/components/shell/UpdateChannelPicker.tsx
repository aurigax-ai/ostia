import { ControlRow, SelectField } from '@/components/settings/SettingsPanel'
import { useDict } from '@/i18n/useDict'
import { saveSettingsNow, useSettingsStore } from '@/stores/app/settingsStore'
import { useUpdateStore } from '@/stores/app/updateStore'
import { isReplaceable } from '@shared/app/installMethod'
import { UPDATE_CHANNELS, type UpdateChannel } from '@shared/app/releases'

export function UpdateChannelPicker(): JSX.Element | null {
  const d = useDict()
  const method = useUpdateStore((s) => s.method)
  const channel = useSettingsStore((s) => s.behavior.updateChannel)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  if (method === 'dev') return null
  const offered = isReplaceable(method)
  const labels: Record<UpdateChannel, string> = {
    stable: d.update.channelStable,
    main: d.update.channelMain,
  }
  const pick = (updateChannel: UpdateChannel): void => {
    useUpdateStore.setState({ releaseCheck: { status: 'idle' } })
    setBehavior({ updateChannel })
    void saveSettingsNow()
  }
  return (
    <ControlRow
      label={d.update.channel}
      desc={offered ? d.update.channelDesc : d.update.channelStableOnly}
    >
      <SelectField
        value={offered ? channel : 'stable'}
        onChange={pick}
        label={d.update.channel}
        disabled={!offered}
        options={UPDATE_CHANNELS.map((c) => ({ value: c, label: labels[c] }))}
      />
    </ControlRow>
  )
}
