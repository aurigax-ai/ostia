import presetData from './devicePresets.json'

interface PresetAgentMetadata {
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
}

export interface DevicePreset {
  id: string
  title: string
  width: number
  height: number
  dpr: number
  mobile: boolean
  touch: boolean
  userAgent: string
  metadata: PresetAgentMetadata
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

function positive(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null
}

function text(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null
}

function presetId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function parseMetadata(raw: unknown): PresetAgentMetadata | null {
  const meta = record(raw)
  if (!meta || typeof meta.mobile !== 'boolean') return null
  const platform = text(meta.platform)
  const platformVersion = text(meta.platformVersion)
  const architecture = text(meta.architecture)
  const model = text(meta.model)
  if (platform === null || platformVersion === null || architecture === null || model === null) {
    return null
  }
  return { platform, platformVersion, architecture, model, mobile: meta.mobile }
}

function parsePreset(raw: unknown): DevicePreset | null {
  const device = record(raw)
  const screen = record(device?.screen)
  const vertical = record(screen?.vertical)
  if (!device || !screen || !vertical) return null
  const title = text(device.title)
  const userAgent = text(device['user-agent'])
  const width = positive(vertical.width)
  const height = positive(vertical.height)
  const dpr = positive(screen['device-pixel-ratio'])
  const metadata = parseMetadata(device['user-agent-metadata'])
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : []
  if (!title || !userAgent || !width || !height || !dpr || !metadata) return null
  return {
    id: presetId(title),
    title,
    width,
    height,
    dpr,
    mobile: capabilities.includes('mobile'),
    touch: capabilities.includes('touch'),
    userAgent,
    metadata,
  }
}

export function parseDevicePresets(raw: unknown): DevicePreset[] {
  const devices = record(raw)?.devices
  if (!Array.isArray(devices)) return []
  const presets: DevicePreset[] = []
  for (const entry of devices) {
    const preset = parsePreset(entry)
    if (preset && !presets.some((p) => p.id === preset.id)) presets.push(preset)
  }
  return presets
}

export const DEVICE_PRESETS: readonly DevicePreset[] = parseDevicePresets(presetData)

export function devicePreset(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id)
}

export function presetUserAgent(preset: DevicePreset, chromeVersion: string): string {
  const major = chromeVersion.split('.')[0]
  return preset.userAgent.replace('%s', `${major}.0.0.0`)
}
