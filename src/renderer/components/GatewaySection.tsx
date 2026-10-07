import { cn } from '@/lib/utils'
import { CaretRightIcon, CopyIcon } from '@phosphor-icons/react'
import {
  DEFAULT_GATEWAY_ROUTE,
  LOOPBACK_ADDRESS,
  formatPhoneAddress,
  parsePhoneAddress,
} from '@shared/gatewayRoute'
import { formatCode } from '@shared/pairCode'
import { PHONE_GRANTABLE_CAPS, type PhoneGrantableCap } from '@shared/phoneCapabilities'
import type {
  GatewayBindAddress,
  GatewayDevice,
  GatewayPairRequest,
  GatewayPairResult,
  GatewayPhoneAddress,
  GatewayRemoteStatus,
  GatewayRoute,
  GatewayTailnetState,
} from '@shared/types'
import QRCode from 'qrcode'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
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
import { Input } from './ui/input'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

const PAIR_CODE_TTL_S = 120

function bindOptions(
  d: Dict,
  addresses: GatewayBindAddress[],
  bindAddress: string,
): { value: string; label: string }[] {
  const options = addresses.map((a) => ({
    value: a.address,
    label: a.loopback
      ? fmt(d.settings.remoteBindLoopback, { address: a.address })
      : fmt(d.settings.remoteRouteAddress, { iface: a.iface, address: a.address }),
  }))
  if (!addresses.some((a) => a.address === bindAddress)) {
    options.push({
      value: bindAddress,
      label: fmt(d.settings.remoteRouteMissing, { address: bindAddress }),
    })
  }
  return options
}

function PhoneAddressRow({
  route,
  disabled,
  onSave,
}: {
  route: GatewayRoute
  disabled: boolean
  onSave: (phoneAddress: GatewayPhoneAddress | null) => Promise<void>
}): JSX.Element {
  const d = useDict()
  const saved = route.phoneAddress ? formatPhoneAddress(route.phoneAddress) : ''
  const [text, setText] = useState(saved)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => setText(saved), [saved])

  const commit = (): void => {
    const trimmed = text.trim()
    if (trimmed === saved) {
      setInvalid(false)
      return
    }
    const phoneAddress = trimmed === '' ? null : parsePhoneAddress(trimmed)
    if (trimmed !== '' && !phoneAddress) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    void onSave(phoneAddress)
  }

  return (
    <ControlRow
      label={d.settings.remotePhoneAddress}
      desc={d.settings.remotePhoneAddressDesc}
      error={invalid ? d.settings.remotePhoneAddressInvalid : null}
      errorId="remote-phone-address-error"
    >
      <Input
        value={text}
        spellCheck={false}
        placeholder="host:port"
        disabled={disabled}
        aria-label={d.settings.remotePhoneAddress}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'remote-phone-address-error' : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className="h-7 w-56 font-mono"
      />
    </ControlRow>
  )
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

const CAP_NEEDS: Partial<Record<PhoneGrantableCap, PhoneGrantableCap>> = {
  destructive: 'command',
}

function capText(d: Dict): Record<PhoneGrantableCap, { label: string; desc: string }> {
  return {
    respond: { label: d.settings.remoteCapRespond, desc: d.settings.remoteCapRespondDesc },
    command: { label: d.settings.remoteCapCommand, desc: d.settings.remoteCapCommandDesc },
    input: { label: d.settings.remoteCapInput, desc: d.settings.remoteCapInputDesc },
    destructive: {
      label: d.settings.remoteCapDestructive,
      desc: d.settings.remoteCapDestructiveDesc,
    },
  }
}

function DeviceRow({
  device,
  onChange,
  onRevoke,
}: {
  device: GatewayDevice
  onChange: (cap: PhoneGrantableCap, granted: boolean) => void
  onRevoke: () => void
}): JSX.Element {
  const d = useDict()
  const [asking, setAsking] = useState(false)
  const text = capText(d)
  return (
    <li className="border-line border-t pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-6 py-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-fg text-ui-base">{device.name}</span>
          <span className="shrink-0 text-fg-muted text-ui-sm tabular-nums">
            {fmt(d.settings.remotePairedOn, {
              date: new Date(device.createdAt).toLocaleDateString(),
            })}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2.5 text-attn-fg hover:text-attn-fg"
          onClick={() => setAsking(true)}
          aria-label={fmt(d.settings.remoteRevokeFor, { name: device.name })}
        >
          {d.settings.remoteRevoke}
        </Button>
      </div>
      <fieldset aria-label={fmt(d.settings.remoteGrantsFor, { name: device.name })}>
        {PHONE_GRANTABLE_CAPS.map((cap) => {
          const needs = CAP_NEEDS[cap]
          const { label, desc } = text[cap]
          return (
            <ControlRow
              key={cap}
              label={label}
              desc={needs ? fmt(d.settings.remoteCapNeeds, { desc, cap: text[needs].label }) : desc}
            >
              <Switch
                checked={device.caps.includes(cap)}
                disabled={needs !== undefined && !device.caps.includes(needs)}
                onCheckedChange={(v) => onChange(cap, v)}
                aria-label={fmt(d.settings.remoteCapFor, { cap: label, name: device.name })}
              />
            </ControlRow>
          )
        })}
      </fieldset>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fmt(d.settings.remoteRevokeTitle, { name: device.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {fmt(d.settings.remoteRevokeBody, { name: device.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{d.settings.remoteCancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={() => {
                setAsking(false)
                onRevoke()
              }}
            >
              {d.settings.remoteRevoke}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
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
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const [nextStatus, { devices: list }] = await Promise.all([
      window.ostia.gateway.status(),
      window.ostia.gateway.devices(),
    ])
    if (!mounted.current) return
    setStatus(nextStatus)
    setTailnet(nextStatus.tailnet)
    setDevices(list)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    void window.ostia.gateway.bindAddresses().then((next) => {
      if (mounted.current) setAddresses(next)
    })
    void window.ostia.gateway.pairRequests().then((next) => {
      if (mounted.current) setRequests(next)
    })
    const offRequests = window.ostia.gateway.onPairRequestsChanged((next) => {
      setRequests(next)
      void refresh()
    })
    const offTailnet = window.ostia.gateway.onTailnetChanged(setTailnet)
    return () => {
      mounted.current = false
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
  const route: GatewayRoute = status?.route ?? DEFAULT_GATEWAY_ROUTE
  const exposed = route.bindAddress !== LOOPBACK_ADDRESS
  const unreachable = !route.tailnet && !exposed && route.phoneAddress === null
  const viaTailnet = route.tailnet
  const canPair = viaTailnet
    ? running && tailnet.state === 'running' && tailnet.ip !== null
    : running && (route.phoneAddress !== null || (exposed && status?.host === route.bindAddress))
  const problem = viaTailnet ? tailnetProblem(d, tailnet) : null

  const onRoute = async (next: Partial<GatewayRoute>): Promise<void> => {
    setRouteError(null)
    await window.ostia.gateway.setRoute({ ...route, ...next })
    await refresh()
  }

  const onToggle = async (checked: boolean): Promise<void> => {
    setSignInError(null)
    setRouteError(null)
    if (checked) {
      const result = await window.ostia.gateway.enable()
      if ('error' in result) {
        setRouteError(fmt(d.settings.remoteAddressUnavailable, { address: route.bindAddress }))
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

      <ControlRow label={d.settings.remoteBind} desc={d.settings.remoteBindDesc}>
        <SelectField
          value={route.bindAddress}
          onChange={(v) => void onRoute({ bindAddress: v })}
          options={bindOptions(d, addresses, route.bindAddress)}
          label={d.settings.remoteBind}
          width="w-fit min-w-64 max-w-80"
          disabled={running}
        />
      </ControlRow>

      <ToggleRow
        label={d.settings.remoteTailnetNode}
        desc={d.settings.remoteTailnetNodeDesc}
        checked={route.tailnet}
        onChange={(v) => void onRoute({ tailnet: v })}
        disabled={running}
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
        <PhoneAddressRow
          route={route}
          disabled={running}
          onSave={(phoneAddress) => onRoute({ phoneAddress })}
        />
      )}

      {unreachable ? <WarningNote>{d.settings.remoteLoopbackOnly}</WarningNote> : null}

      {exposed ? (
        <WarningNote>
          {fmt(d.settings.remoteAddressWarning, { address: route.bindAddress })}
        </WarningNote>
      ) : null}

      <ToggleRow
        label={d.settings.remoteDiscoverable}
        desc={d.settings.remoteDiscoverableDesc}
        checked={status?.discoverable ?? false}
        onChange={(v) => void onDiscoverable(v)}
      />

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
        <ul className="flex flex-col">
          {devices.map((dev) => (
            <DeviceRow
              key={dev.deviceId}
              device={dev}
              onChange={(cap, v) => onCapChange(dev, cap, v)}
              onRevoke={() => void onRevoke(dev.deviceId)}
            />
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
