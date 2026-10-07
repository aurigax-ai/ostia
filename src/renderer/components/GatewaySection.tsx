import { cn } from '@/lib/utils'
import { CaretRightIcon, CopyIcon } from '@phosphor-icons/react'
import { PHONE_GRANTABLE_CAPS, type PhoneGrantableCap } from '@shared/capabilities'
import { formatCode } from '@shared/pairCode'
import type {
  GatewayBindAddress,
  GatewayDevice,
  GatewayPairRequest,
  GatewayPairResult,
  GatewayRemoteStatus,
  GatewayRoute,
  GatewayTailnetState,
} from '@shared/types'
import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import {
  ControlRow,
  SectionHead,
  SelectField,
  SubHead,
  ToggleRow,
  WarningNote,
} from './SettingsPanel'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

const PAIR_CODE_TTL_S = 120
const TAILNET_CHOICE = 'tailnet'

function routeChoice(route: GatewayRoute): string {
  return route.kind === 'tailnet' ? TAILNET_CHOICE : route.address
}

function routeOf(choice: string): GatewayRoute {
  return choice === TAILNET_CHOICE ? { kind: 'tailnet' } : { kind: 'address', address: choice }
}

function routeOptions(
  d: Dict,
  addresses: GatewayBindAddress[],
  route: GatewayRoute,
): { value: string; label: string }[] {
  const options = [
    { value: TAILNET_CHOICE, label: d.settings.remoteRouteTailnet },
    ...addresses.map((a) => ({
      value: a.address,
      label: fmt(d.settings.remoteRouteAddress, { iface: a.iface, address: a.address }),
    })),
  ]
  if (route.kind === 'address' && !addresses.some((a) => a.address === route.address)) {
    options.push({
      value: route.address,
      label: fmt(d.settings.remoteRouteMissing, { address: route.address }),
    })
  }
  return options
}

function tailnetSummary(d: Dict, node: GatewayTailnetState): string {
  if (node.state === 'starting') return d.settings.remoteTailnetStarting
  if (node.state === 'needs-login') return d.settings.remoteTailnetNeedsLogin
  if (node.state === 'running') {
    return fmt(d.settings.remoteTailnetRunning, { name: node.dnsName ?? '', ip: node.ip ?? '' })
  }
  return d.settings.remoteTailnetOff
}

function tailnetProblem(d: Dict, node: GatewayTailnetState): string | null {
  if (node.state === 'running' && !node.ip) return d.settings.remoteTailnetNoIpv4
  if (node.state !== 'error') return null
  if (node.code === 'helper-stopped') return d.settings.remoteTailnetHelperStopped
  if (node.code === 'state-dir-unsafe') return d.settings.remoteTailnetStateDirUnsafe
  if (node.code === 'helper-unavailable') return d.settings.remoteTailnetUnavailable
  return fmt(d.settings.remoteTailnetError, { code: node.code })
}

function spacedCheckCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function PairRequests({
  requests,
  onAnswer,
}: {
  requests: GatewayPairRequest[]
  onAnswer: (requestId: string, approve: boolean) => void
}): JSX.Element | null {
  const d = useDict()
  if (requests.length === 0) return null
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {requests.map((r) => (
        <li
          key={r.requestId}
          className="motion-enter flex items-center justify-between gap-4 rounded-md border border-line-strong bg-surface-1 p-3"
        >
          <div className="min-w-0">
            <div className="truncate text-fg text-ui-base">
              {fmt(d.settings.remotePairRequest, { name: r.name })}
            </div>
            <div className="mt-1 font-mono font-semibold text-fg text-ui-lg tabular-nums">
              {spacedCheckCode(r.checkCode)}
            </div>
            <p className="mt-0.5 text-fg-muted text-ui-sm">{d.settings.remotePairCheck}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAnswer(r.requestId, false)}
              aria-label={fmt(d.settings.remotePairDenyFor, { name: r.name })}
            >
              {d.settings.remotePairDeny}
            </Button>
            <Button
              size="sm"
              onClick={() => onAnswer(r.requestId, true)}
              aria-label={fmt(d.settings.remotePairApproveFor, { name: r.name })}
            >
              {d.settings.remotePairApprove}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function capLabel(d: Dict, cap: PhoneGrantableCap): string {
  if (cap === 'command') return d.settings.remoteCapCommand
  if (cap === 'input') return d.settings.remoteCapInput
  return d.settings.remoteCapDestructive
}

function DeviceGrants({
  device,
  onChange,
}: {
  device: GatewayDevice
  onChange: (cap: PhoneGrantableCap, granted: boolean) => void
}): JSX.Element {
  const d = useDict()
  return (
    <fieldset
      aria-label={fmt(d.settings.remoteGrantsFor, { name: device.name })}
      className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1"
    >
      {PHONE_GRANTABLE_CAPS.map((cap) => {
        const label = fmt(d.settings.remoteCapFor, { cap: capLabel(d, cap), name: device.name })
        const disabled = cap === 'destructive' && !device.caps.includes('command')
        return (
          <div key={cap} className="flex items-center justify-between gap-2 text-fg text-ui-sm">
            {capLabel(d, cap)}
            <Switch
              checked={device.caps.includes(cap)}
              disabled={disabled}
              onCheckedChange={(v) => onChange(cap, v)}
              aria-label={label}
            />
          </div>
        )
      })}
    </fieldset>
  )
}

export function GatewaySection(): JSX.Element {
  const d = useDict()
  const [status, setStatus] = useState<GatewayRemoteStatus | null>(null)
  const [tailnet, setTailnet] = useState<GatewayTailnetState>({ state: 'off' })
  const [devices, setDevices] = useState<GatewayDevice[]>([])
  const [addresses, setAddresses] = useState<GatewayBindAddress[]>([])
  const [routeError, setRouteError] = useState<string | null>(null)
  const [confirmDevice, setConfirmDevice] = useState<GatewayDevice | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [pairResult, setPairResult] = useState<GatewayPairResult | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [copied, setCopied] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [requests, setRequests] = useState<GatewayPairRequest[]>([])

  const refresh = useCallback(async () => {
    const [nextStatus, { devices: list }] = await Promise.all([
      window.ostia.gateway.status(),
      window.ostia.gateway.devices(),
    ])
    setStatus(nextStatus)
    setTailnet(nextStatus.tailnet)
    setDevices(list)
  }, [])

  useEffect(() => {
    void refresh()
    void window.ostia.gateway.bindAddresses().then(setAddresses)
    void window.ostia.gateway.pairRequests().then(setRequests)
    const offRequests = window.ostia.gateway.onPairRequestsChanged((next) => {
      setRequests(next)
      void refresh()
    })
    const offTailnet = window.ostia.gateway.onTailnetChanged(setTailnet)
    return () => {
      offRequests()
      offTailnet()
    }
  }, [refresh])

  const mintCode = useCallback(async (): Promise<void> => {
    setPairing(true)
    setCopied(false)
    try {
      const result = await window.ostia.gateway.pair()
      if ('error' in result) return
      setPairResult(result)
      setSecondsLeft(PAIR_CODE_TTL_S)
      const dataUrl = await QRCode.toDataURL(JSON.stringify(result), { margin: 1, width: 220 })
      setQrDataUrl(dataUrl)
    } finally {
      setPairing(false)
      await refresh()
    }
  }, [refresh])

  useEffect(() => {
    if (!pairResult) return
    if (secondsLeft <= 0) {
      void mintCode()
      return
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [pairResult, secondsLeft, mintCode])

  const running = status?.running ?? false
  const route: GatewayRoute = status?.route ?? { kind: 'tailnet' }
  const viaTailnet = route.kind === 'tailnet'
  const canPair = viaTailnet
    ? running && tailnet.state === 'running' && tailnet.ip !== null
    : running && status?.host === route.address
  const problem = viaTailnet ? tailnetProblem(d, tailnet) : null

  const onRoute = async (choice: string): Promise<void> => {
    setRouteError(null)
    await window.ostia.gateway.setRoute(routeOf(choice))
    await refresh()
  }

  const onToggle = async (checked: boolean): Promise<void> => {
    setSignInError(null)
    setRouteError(null)
    if (checked) {
      const result = await window.ostia.gateway.enable()
      if ('error' in result && route.kind === 'address') {
        setRouteError(fmt(d.settings.remoteAddressUnavailable, { address: route.address }))
      }
    } else {
      await window.ostia.gateway.disable()
      setPairResult(null)
      setQrDataUrl(null)
    }
    await refresh()
  }

  const onSignIn = async (): Promise<void> => {
    const result = await window.ostia.gateway.tailnetSignIn()
    setSignInError(
      !result.ok && result.error === 'login-link-refused'
        ? d.settings.remoteTailnetLoginRefused
        : null,
    )
  }

  const onSignOut = async (): Promise<void> => {
    await window.ostia.gateway.tailnetSignOut()
    setPairResult(null)
    setQrDataUrl(null)
    await refresh()
  }

  const onDiscoverable = async (on: boolean): Promise<void> => {
    await window.ostia.gateway.setDiscoverable(on)
    await refresh()
  }

  const onAnswer = async (requestId: string, approve: boolean): Promise<void> => {
    await window.ostia.gateway.answerPairRequest(requestId, approve)
    setRequests(await window.ostia.gateway.pairRequests())
    await refresh()
  }

  const onRevoke = async (deviceId: string): Promise<void> => {
    await window.ostia.gateway.revoke(deviceId)
    await refresh()
  }

  const setCap = async (deviceId: string, cap: PhoneGrantableCap, granted: boolean) => {
    await window.ostia.gateway.setCap(deviceId, cap, granted)
    await refresh()
  }

  const onCapChange = (device: GatewayDevice, cap: PhoneGrantableCap, granted: boolean): void => {
    if (cap === 'destructive' && granted) {
      setConfirmDevice(device)
      return
    }
    void setCap(device.deviceId, cap, granted)
  }

  const onConfirmDestructive = async (): Promise<void> => {
    const device = confirmDevice
    setConfirmDevice(null)
    if (device) await setCap(device.deviceId, 'destructive', true)
  }

  const onCopy = async (): Promise<void> => {
    if (!pairResult) return
    await navigator.clipboard.writeText(JSON.stringify(pairResult))
    setCopied(true)
  }

  return (
    <section>
      <SectionHead title={d.settings.remote} desc={d.settings.remoteDesc} />

      <ToggleRow
        label={d.settings.remoteEnable}
        desc={d.settings.remoteEnableDesc}
        checked={running}
        onChange={(v) => void onToggle(v)}
      />

      <ControlRow label={d.settings.remoteRoute} desc={d.settings.remoteRouteDesc}>
        <SelectField
          value={routeChoice(route)}
          onChange={(v) => void onRoute(v)}
          options={routeOptions(d, addresses, route)}
          label={d.settings.remoteRoute}
          width="w-fit min-w-64 max-w-80"
          disabled={running}
        />
      </ControlRow>

      <ToggleRow
        label={d.settings.remoteDiscoverable}
        desc={d.settings.remoteDiscoverableDesc}
        checked={status?.discoverable ?? false}
        onChange={(v) => void onDiscoverable(v)}
      />

      {viaTailnet ? (
        <ControlRow
          label={d.settings.remoteTailscale}
          desc={d.settings.remoteTailscaleDesc}
          below={
            <span className="flex min-w-0 items-center gap-2 text-fg-muted text-ui-sm">
              <span className={`dot ${tailnet.state === 'running' ? 'done' : ''}`} />
              <span className="min-w-0 truncate">{tailnetSummary(d, tailnet)}</span>
              {running && tailnet.state === 'needs-login' ? (
                <Button variant="outline" size="sm" onClick={() => void onSignIn()}>
                  {d.settings.remoteTailnetSignIn}
                </Button>
              ) : null}
              {tailnet.state === 'running' ? (
                <Button variant="ghost" size="sm" onClick={() => void onSignOut()}>
                  {d.settings.remoteTailnetSignOut}
                </Button>
              ) : null}
            </span>
          }
        />
      ) : (
        <WarningNote>
          {fmt(d.settings.remoteAddressWarning, { address: route.address })}
        </WarningNote>
      )}

      {problem ? <WarningNote>{problem}</WarningNote> : null}
      {signInError ? <WarningNote>{signInError}</WarningNote> : null}
      {routeError ? <WarningNote>{routeError}</WarningNote> : null}

      <Separator className="my-3" />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-fg text-ui-base">{d.settings.remotePair}</div>
          <p className="mt-0.5 text-fg-muted text-ui-sm">{d.settings.remotePairDesc}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void mintCode()}
          disabled={pairing || !canPair}
        >
          {pairing ? d.settings.remotePairing : d.settings.remotePairButton}
        </Button>
      </div>

      <PairRequests requests={requests} onAnswer={(id, approve) => void onAnswer(id, approve)} />

      {pairResult && qrDataUrl ? (
        <div className="mt-3 rounded-md border border-line bg-surface-1 p-4">
          <div className="flex flex-wrap items-center gap-6">
            <img
              src={qrDataUrl}
              alt={d.settings.remotePair}
              width={180}
              height={180}
              className="shrink-0 rounded-md bg-white p-2"
            />
            <dl className="flex min-w-0 flex-col gap-3">
              <div>
                <dt className="text-fg-muted text-ui-xs">{d.settings.remotePairCode}</dt>
                <dd className="select-all font-mono font-semibold text-fg text-ui-lg">
                  {formatCode(pairResult.pairCode)}
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted text-ui-xs">{d.settings.remotePairAddress}</dt>
                <dd className="font-mono text-fg text-ui-sm">
                  {pairResult.host}:{pairResult.port}
                </dd>
              </div>
              <p className="text-fg-muted text-ui-xs">
                {fmt(d.settings.remotePairExpires, { n: Math.max(secondsLeft, 0) })}
              </p>
            </dl>
          </div>
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-3">
            <div className="flex items-center justify-between">
              <CollapsibleTrigger
                render={
                  <Button variant="ghost" size="xs" className="-ml-2 text-fg-muted hover:text-fg">
                    <CaretRightIcon
                      className={cn('transition-transform', detailsOpen && 'rotate-90')}
                    />
                    {d.settings.remotePairDetails}
                  </Button>
                }
              />
              <Button variant="ghost" size="xs" onClick={() => void onCopy()}>
                <CopyIcon data-icon="inline-start" />
                {copied ? d.settings.remoteCopied : d.settings.remoteCopy}
              </Button>
            </div>
            <CollapsibleContent>
              <Textarea
                readOnly
                value={JSON.stringify(pairResult, null, 2)}
                rows={8}
                aria-label={d.settings.remotePairDetails}
                className="field-sizing-fixed mt-1 resize-none font-mono text-fg-muted"
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}

      <Separator className="my-3" />

      <SubHead
        title={d.settings.remoteDevices}
        desc={devices.length > 0 ? d.settings.remoteGrantsDesc : undefined}
      />
      {devices.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.settings.remoteNoDevices}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {devices.map((dev) => (
            <li key={dev.deviceId} className="rounded-sm px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-fg text-ui-base">{dev.name}</div>
                  <div className="truncate text-fg-muted text-ui-xs tabular-nums">
                    {fmt(d.settings.remotePairedOn, {
                      date: new Date(dev.createdAt).toLocaleDateString(),
                    })}
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void onRevoke(dev.deviceId)}
                  aria-label={fmt(d.settings.remoteRevokeFor, { name: dev.name })}
                >
                  {d.settings.remoteRevoke}
                </Button>
              </div>
              <DeviceGrants device={dev} onChange={(cap, v) => onCapChange(dev, cap, v)} />
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={confirmDevice !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDevice(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{d.settings.remoteDestructiveTitle}</DialogTitle>
            <DialogDescription>
              {fmt(d.settings.remoteDestructiveBody, { name: confirmDevice?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDevice(null)}>
              {d.settings.remoteCancel}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void onConfirmDestructive()}>
              {d.settings.remoteDestructiveConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
