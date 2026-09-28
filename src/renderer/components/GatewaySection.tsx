import type { GatewayDevice, GatewayPairResult, GatewayStatus } from '@shared/types'
import { Copy } from 'lucide-react'
import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { ControlRow, SectionHead, ToggleRow } from './SettingsPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

const PAIR_CODE_TTL_S = 120

export function GatewaySection(): JSX.Element {
  const d = useDict()
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [devices, setDevices] = useState<GatewayDevice[]>([])
  const [hostInput, setHostInput] = useState('')
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
        const result = await window.pine.gateway.enable({ host: hostInput.trim() || undefined })
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
        <Input
          value={hostInput}
          onChange={(e) => setHostInput(e.target.value)}
          placeholder={d.settings.remoteHostPlaceholder}
          disabled={running || toggling}
          aria-label={d.settings.remoteHost}
          className="h-7 w-40 font-mono"
        />
      </ControlRow>

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
      {devices.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.settings.remoteNoDevices}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {devices.map((dev) => (
            <li
              key={dev.deviceId}
              className="flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 hover:bg-surface-2/60"
            >
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
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
