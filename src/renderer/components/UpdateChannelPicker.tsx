import { offersUpdateChannels } from '@shared/installMethod'
import { UPDATE_CHANNELS, type UpdateChannel } from '@shared/releases'
import { useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { useUpdateStore } from '../stores/updateStore'
import { ControlRow, SelectField } from './SettingsPanel'

export function UpdateChannelPicker(): JSX.Element | null {
  const d = useDict()
  const method = useUpdateStore((s) => s.method)
  const channel = useSettingsStore((s) => s.behavior.updateChannel)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  if (method === 'dev') return null
  const offered = offersUpdateChannels(method)
  const labels: Record<UpdateChannel, string> = {
    stable: d.update.channelStable,
    main: d.update.channelMain,
  }
  const pick = (updateChannel: UpdateChannel): void => {
    useUpdateStore.setState({ releaseCheck: { status: 'idle' } })
    setBehavior({ updateChannel })
  }
  return (
    <ControlRow label={d.update.channel} desc={offered ? d.update.channelDesc : d.update.channelStableOnly}>
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
