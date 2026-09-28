import { PHONE_GRANTABLE_CAPS, type PhoneGrantableCap } from '@shared/capabilities'
import type {
  GatewayBindAddress,
  GatewayBindKind,
  GatewayDevice,
  GatewayPairResult,
  GatewayStatus,
} from '@shared/types'
import { Copy } from 'lucide-react'
import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { ControlRow, SectionHead, ToggleRow } from './SettingsPanel'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

const PAIR_CODE_TTL_S = 120
const LOOPBACK = '127.0.0.1'

function bindKindLabel(d: Dict, kind: GatewayBindKind): string {
  if (kind === 'loopback') return d.settings.remoteBindLoopback
  if (kind === 'lan') return d.settings.remoteBindLan
  if (kind === 'tailscale') return d.settings.remoteBindTailscale
  return d.settings.remoteBindCustom
}

function bindLabel(d: Dict, a: GatewayBindAddress): string {
  const kind = bindKindLabel(d, a.kind)
  return `${a.iface ? `${kind} (${a.iface})` : kind} · ${a.address}`
}

function capLabel(d: Dict, cap: PhoneGrantableCap): string {
  if (cap === 'command') return d.settings.remoteCapCommand
  if (cap === 'input') return d.settings.remoteCapInput
  if (cap === 'board.write') return d.settings.remoteCapBoardWrite
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
      aria-label={`${d.settings.remoteGrants} — ${device.name}`}
      className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1"
    >
      {PHONE_GRANTABLE_CAPS.map((cap) => {
        const label = `${capLabel(d, cap)} — ${device.name}`
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
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [devices, setDevices] = useState<GatewayDevice[]>([])
  const [addresses, setAddresses] = useState<GatewayBindAddress[]>([])
  const [host, setHost] = useState(LOOPBACK)
  const [confirmDevice, setConfirmDevice] = useState<GatewayDevice | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [pairResult, setPairResult] = useState<GatewayPairResult | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    const [nextStatus, { devices: list }] = await Promise.all([
      window.pine.gateway.status(),
      window.pine.gateway.devices(),
    ])
    setStatus(nextStatus)
    setDevices(list)
  }, [])

  useEffect(() => {
    void refresh()
    void window.pine.gateway.bindOptions().then((opts) => {
      setAddresses(opts.addresses)
      setHost(opts.selected)
    })
  }, [refresh])

  useEffect(() => {
    if (!pairResult || secondsLeft <= 0) return
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [pairResult, secondsLeft])

  const expired = pairResult !== null && secondsLeft <= 0
  const running = status?.running ?? false

  const onToggle = async (checked: boolean): Promise<void> => {
    setToggling(true)
    try {
      if (checked) {
        const result = await window.pine.gateway.enable({ host })
        setWarning(result.warning ?? null)
      } else {
        await window.pine.gateway.disable()
        setWarning(null)
        setPairResult(null)
        setQrDataUrl(null)
      }
    } finally {
      setToggling(false)
      await refresh()
    }
  }

  const onPair = async (): Promise<void> => {
    setPairing(true)
    setCopied(false)
    try {
      const result = await window.pine.gateway.pair()
      setPairResult(result)
      setWarning(result.warning ?? null)
      setSecondsLeft(PAIR_CODE_TTL_S)
      const dataUrl = await QRCode.toDataURL(JSON.stringify(result), { margin: 1, width: 220 })
      setQrDataUrl(dataUrl)
    } finally {
      setPairing(false)
      await refresh()
    }
  }

  const onRevoke = async (deviceId: string): Promise<void> => {
    await window.pine.gateway.revoke(deviceId)
    await refresh()
  }

  const setCap = async (deviceId: string, cap: PhoneGrantableCap, granted: boolean) => {
    await window.pine.gateway.setCap(deviceId, cap, granted)
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

  const exposed = host !== LOOPBACK && host !== '::1' && host !== 'localhost'
  const selectedAddress = addresses.find((a) => a.address === host)

  const onCopy = async (): Promise<void> => {
    if (!pairResult) return
    await navigator.clipboard.writeText(JSON.stringify(pairResult))
    setCopied(true)
  }

  return (
    <section>
      <SectionHead title={d.settings.remote} />
      <p className="mb-2 text-fg-muted text-ui-sm">{d.settings.remoteDesc}</p>

      <ToggleRow
        label={d.settings.remoteEnable}
        desc={d.settings.remoteEnableDesc}
        checked={running}
        onChange={(v) => void onToggle(v)}
      />

      <ControlRow label={d.settings.remoteHost} desc={d.settings.remoteHostDesc}>
        <Select value={host} onValueChange={(v) => setHost(String(v))}>
          <SelectTrigger
            size="sm"
            aria-label={d.settings.remoteHost}
            className="w-64 font-mono"
            disabled={running || toggling}
          >
            {selectedAddress ? bindLabel(d, selectedAddress) : host}
          </SelectTrigger>
          <SelectContent>
            {addresses.map((a) => (
              <SelectItem key={a.address} value={a.address}>
                {bindLabel(d, a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ControlRow>

      {exposed && !warning ? (
        <p className="mt-1 rounded-md border border-attn/40 bg-attn/10 px-2.5 py-1.5 text-attn-fg text-ui-sm">
          {fmt(d.settings.remoteExposedWarning, { host })}
        </p>
      ) : null}

      <ControlRow label={d.settings.remoteStatus}>
        <span className="flex items-center gap-2 text-fg-muted text-ui-sm">
          <span className={`dot ${running ? 'done' : ''}`} />
          {running && status?.host
            ? fmt(d.settings.remoteRunning, { host: `${status.host}:${status.port}` })
            : d.settings.remoteStopped}
        </span>
      </ControlRow>

      {warning ? (
        <p className="mt-1 rounded-md border border-attn/40 bg-attn/10 px-2.5 py-1.5 text-attn-fg text-ui-sm">
          {warning}
        </p>
      ) : null}

      <Separator className="my-3" />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-fg text-ui-base">{d.settings.remotePair}</div>
          <p className="mt-0.5 text-fg-muted text-ui-sm">{d.settings.remotePairDesc}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onPair()} disabled={pairing}>
          {pairing ? d.settings.remotePairing : d.settings.remotePairButton}
        </Button>
      </div>

      {pairResult && qrDataUrl ? (
        <div className="mt-3 flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-1 p-4">
          <img
            src={qrDataUrl}
            alt={d.settings.remotePair}
            width={220}
            height={220}
            className="rounded-md bg-white p-2"
          />
          <div className="w-full">
            <div className="flex items-center justify-between">
              <span className="text-fg-muted text-ui-xs">
                {expired
                  ? d.settings.remotePairExpired
                  : fmt(d.settings.remotePairExpires, { n: secondsLeft })}
              </span>
              <Button variant="ghost" size="xs" onClick={() => void onCopy()}>
                <Copy data-icon="inline-start" />
                {copied ? d.settings.remoteCopied : d.settings.remoteCopy}
              </Button>
            </div>
            <Textarea
              readOnly
              value={JSON.stringify(pairResult, null, 2)}
              rows={5}
              aria-label={d.settings.remotePair}
              className="field-sizing-fixed mt-1 resize-none font-mono text-fg-muted"
            />
          </div>
        </div>
      ) : null}

      <Separator className="my-3" />

      <div className="mb-1 text-fg text-ui-base">{d.settings.remoteDevices}</div>
      {devices.length > 0 ? (
        <p className="mb-1.5 text-fg-muted text-ui-sm">{d.settings.remoteGrantsDesc}</p>
      ) : null}
      {devices.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.settings.remoteNoDevices}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {devices.map((dev) => (
            <li key={dev.deviceId} className="rounded-sm px-2.5 py-1.5 hover:bg-surface-2/60">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-fg text-ui-base">{dev.name}</div>
                  <div className="truncate font-mono text-fg-muted text-ui-xs">
                    {dev.caps.join(', ')} · {new Date(dev.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void onRevoke(dev.deviceId)}
                  aria-label={`${d.settings.remoteRevoke} ${dev.name}`}
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
