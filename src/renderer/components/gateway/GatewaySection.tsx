import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { DeviceList } from './GatewayDevices'
import { PairCodePanel, PairRequests } from './GatewayPairing'
import { GatewayPhoneWorkspace } from './GatewayPhoneWorkspace'
import { GatewayRouteRows } from './GatewayRouteRows'
import { useGatewayRoute } from './useGatewayRoute'
import { useGatewayStatus } from './useGatewayStatus'
import { usePairCode } from './usePairCode'

export function GatewaySection(): JSX.Element {
  const d = useDict()
  const gateway = useGatewayStatus()
  const pair = usePairCode(gateway.refresh)
  const routing = useGatewayRoute({
    status: gateway.status,
    tailnet: gateway.tailnet,
    relay: gateway.relay,
    refresh: gateway.refresh,
    clearPairing: pair.clear,
  })
  const { setRequests, refresh, requests, devices } = gateway
  const shown = pair.pairResult !== null

  const onAnswer = async (requestId: string, approve: boolean): Promise<void> => {
    await window.ostia.gateway.answerPairRequest(requestId, approve)
    setRequests(await window.ostia.gateway.pairRequests())
    await refresh()
  }

  return (
    <SettingsPage title={d.settings.remote} desc={d.settings.remoteDesc}>
      <GatewayRouteRows gateway={gateway} routing={routing} />

      <SettingsGroup title={d.settings.remotePairGroup}>
        <ControlRow label={d.settings.remotePair} desc={d.settings.remotePairDesc}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => (shown ? pair.clear() : void pair.mintCode())}
            disabled={!shown && (pair.pairing || !routing.canPair)}
          >
            {shown ? d.settings.remotePairHide : d.settings.remotePairShow}
          </Button>
        </ControlRow>
        <PairCodePanel pair={pair} />
        <PairRequests requests={requests} onAnswer={(id, approve) => void onAnswer(id, approve)} />
      </SettingsGroup>

      <DeviceList
        devices={devices}
        push={gateway.status?.push ?? 'unreachable'}
        refresh={refresh}
      />

      <GatewayPhoneWorkspace />
    </SettingsPage>
  )
}
