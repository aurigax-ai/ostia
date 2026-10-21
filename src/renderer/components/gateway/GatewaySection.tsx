import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
  const { pairing, mintCode } = pair
  const { canPair } = routing

  const onAnswer = async (requestId: string, approve: boolean): Promise<void> => {
    await window.ostia.gateway.answerPairRequest(requestId, approve)
    setRequests(await window.ostia.gateway.pairRequests())
    await refresh()
  }

  return (
    <SettingsPage title={d.settings.remote} desc={d.settings.remoteDesc}>
      <GatewayRouteRows gateway={gateway} routing={routing} />

      <Separator className="my-3" />

      <ControlRow label={d.settings.remotePair} desc={d.settings.remotePairDesc}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void mintCode()}
          disabled={pairing || !canPair}
        >
          {pairing ? d.settings.remotePairing : d.settings.remotePairButton}
        </Button>
      </ControlRow>

      <PairRequests requests={requests} onAnswer={(id, approve) => void onAnswer(id, approve)} />

      <PairCodePanel pair={pair} />

      <Separator className="my-3" />

      <DeviceList devices={devices} refresh={refresh} />

      <GatewayPhoneWorkspace />
    </SettingsPage>
  )
}
