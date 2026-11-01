import { DeviceRotateIcon } from '@phosphor-icons/react'
import {
  type BrowserDevice,
  DEVICE_DPRS,
  type DeviceZoom,
  RESPONSIVE,
  resized,
  rotated,
  withPreset,
} from '@shared/browser/browserDevice'
import { DEVICE_PRESETS } from '@shared/browser/devicePresets'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { NumberInput } from '@/components/settingsKit/CommitInput'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { fmt, useDict } from '@/lib/app/useDict'

function SizeInput({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: number
  label: string
  disabled: boolean
  onCommit: (size: number) => void
}): JSX.Element {
  return (
    <NumberInput
      aria-label={label}
      className="h-6 w-16 font-mono text-ui-sm md:text-ui-sm"
      value={value}
      disabled={disabled}
      onCommit={onCommit}
    />
  )
}

export function DeviceBar({
  device,
  onChange,
}: {
  device: BrowserDevice
  onChange: (next: BrowserDevice) => void
}): JSX.Element {
  const d = useDict()
  const responsive = device.preset === RESPONSIVE
  const presetTitle =
    DEVICE_PRESETS.find((preset) => preset.id === device.preset)?.title ??
    d.browser.deviceResponsive
  const dprs = DEVICE_DPRS.includes(device.dpr) ? DEVICE_DPRS : [...DEVICE_DPRS, device.dpr]
  const zoomLabels: Record<DeviceZoom, string> = {
    fit: d.browser.deviceZoomFit,
    actual: d.browser.deviceZoomActual,
  }
  return (
    <div role="toolbar" aria-label={d.browser.deviceBar} className="browser-device-bar">
      <Select
        value={device.preset}
        onValueChange={(id) => {
          if (typeof id === 'string') onChange(withPreset(device, id))
        }}
      >
        <SelectTrigger size="sm" aria-label={d.browser.devicePreset} className="h-6 min-w-36">
          <span className="min-w-0 truncate">{presetTitle}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RESPONSIVE}>{d.browser.deviceResponsive}</SelectItem>
          {DEVICE_PRESETS.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>
              {preset.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SizeInput
        value={device.width}
        label={d.browser.deviceWidth}
        disabled={!responsive}
        onCommit={(width) => onChange(resized(device, width, device.height))}
      />
      <span className="text-ui-sm text-fg-muted" aria-hidden="true">
        ×
      </span>
      <SizeInput
        value={device.height}
        label={d.browser.deviceHeight}
        disabled={!responsive}
        onCommit={(height) => onChange(resized(device, device.width, height))}
      />
      <Select
        value={String(device.dpr)}
        disabled={!responsive}
        onValueChange={(value) => {
          const dpr = Number(value)
          if (DEVICE_DPRS.includes(dpr)) onChange({ ...device, dpr })
        }}
      >
        <SelectTrigger size="sm" aria-label={d.browser.deviceDpr} className="h-6">
          <span>{fmt(d.browser.deviceDprValue, { dpr: device.dpr })}</span>
        </SelectTrigger>
        <SelectContent>
          {dprs.map((dpr) => (
            <SelectItem key={dpr} value={String(dpr)}>
              {fmt(d.browser.deviceDprValue, { dpr })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={device.zoom}
        onValueChange={(zoom) => {
          if (zoom === 'fit' || zoom === 'actual') onChange({ ...device, zoom })
        }}
      >
        <SelectTrigger size="sm" aria-label={d.browser.deviceZoom} className="h-6">
          <span>{zoomLabels[device.zoom]}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fit">{zoomLabels.fit}</SelectItem>
          <SelectItem value="actual">{zoomLabels.actual}</SelectItem>
        </SelectContent>
      </Select>
      <IconButton
        icon={DeviceRotateIcon}
        label={d.browser.deviceRotate}
        onClick={() => onChange(rotated(device))}
      />
    </div>
  )
}
