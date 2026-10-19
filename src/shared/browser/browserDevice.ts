import { type DevicePreset, devicePreset } from './devicePresets'

export type DeviceZoom = 'fit' | 'actual'

export const RESPONSIVE = 'responsive'

export interface BrowserDevice {
  preset: string
  width: number
  height: number
  dpr: number
  zoom: DeviceZoom
}

export const DEVICE_SIZE_MIN = 50
export const DEVICE_SIZE_MAX = 9999
export const DEVICE_DPRS: readonly number[] = [1, 2, 3]

export const DEFAULT_DEVICE: BrowserDevice = {
  preset: RESPONSIVE,
  width: 400,
  height: 800,
  dpr: 1,
  zoom: 'fit',
}

function clampDeviceSize(size: number): number {
  return Math.min(DEVICE_SIZE_MAX, Math.max(DEVICE_SIZE_MIN, Math.round(size)))
}

function sizeOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? clampDeviceSize(raw) : null
}

function presetSized(preset: DevicePreset, landscape: boolean, zoom: DeviceZoom): BrowserDevice {
  return {
    preset: preset.id,
    width: landscape ? preset.height : preset.width,
    height: landscape ? preset.width : preset.height,
    dpr: preset.dpr,
    zoom,
  }
}

export function parseBrowserDevice(raw: unknown): BrowserDevice | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const fields = raw as Record<string, unknown>
  const width = sizeOf(fields.width)
  const height = sizeOf(fields.height)
  if (width === null || height === null) return undefined
  const zoom: DeviceZoom = fields.zoom === 'actual' ? 'actual' : 'fit'
  const preset = typeof fields.preset === 'string' ? devicePreset(fields.preset) : undefined
  if (preset) return presetSized(preset, width > height, zoom)
  const dpr = typeof fields.dpr === 'number' && DEVICE_DPRS.includes(fields.dpr) ? fields.dpr : 1
  return { preset: RESPONSIVE, width, height, dpr, zoom }
}

export function withPreset(device: BrowserDevice, id: string): BrowserDevice {
  const preset = devicePreset(id)
  if (!preset) return { ...device, preset: RESPONSIVE }
  return presetSized(preset, false, device.zoom)
}

export function rotated(device: BrowserDevice): BrowserDevice {
  return { ...device, width: device.height, height: device.width }
}

export function resized(device: BrowserDevice, width: number, height: number): BrowserDevice {
  if (device.preset !== RESPONSIVE) return device
  const next = { ...device, width: clampDeviceSize(width), height: clampDeviceSize(height) }
  return next.width === device.width && next.height === device.height ? device : next
}
