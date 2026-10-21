import { ipcMain } from 'electron'
import { type BrowserDevice, parseBrowserDevice } from '../../shared/browser/browserDevice'
import { devicePreset, presetUserAgent } from '../../shared/browser/devicePresets'
import { type DeviceTouch, parseDeviceTouch } from '../../shared/browser/deviceTouch'
import { ownedGuest } from './browseGuests'
import { debuggerCommand } from './browseMethod'
import { type DeviceAgent, setDeviceAgent, type UserAgentMetadata } from './signinUserAgent'

export interface DeviceEmulation {
  width: number
  height: number
  dpr: number
  mobile: boolean
  touch: boolean
  agent: DeviceAgent | null
}

export function deviceEmulation(device: BrowserDevice, base: UserAgentMetadata): DeviceEmulation {
  const preset = devicePreset(device.preset)
  const size = { width: device.width, height: device.height, dpr: device.dpr }
  if (!preset) return { ...size, mobile: false, touch: false, agent: null }
  return {
    ...size,
    mobile: preset.mobile,
    touch: preset.touch,
    agent: {
      userAgent: presetUserAgent(preset, base.fullVersion),
      metadata: { ...base, ...preset.metadata },
    },
  }
}

function identityOf(emulation: DeviceEmulation | null): string {
  return JSON.stringify([
    emulation?.agent?.userAgent ?? null,
    emulation?.mobile ?? false,
    emulation?.touch ?? false,
  ])
}

const DESKTOP = identityOf(null)

const identities = new WeakMap<Electron.WebContents, string>()
const emulations = new WeakMap<Electron.WebContents, DeviceEmulation>()

export function inDeviceMode(guest: Electron.WebContents): boolean {
  return emulations.has(guest)
}

async function emulate(guest: Electron.WebContents, emulation: DeviceEmulation): Promise<void> {
  const landscape = emulation.width > emulation.height
  await debuggerCommand(guest, 'Emulation.setDeviceMetricsOverride', {
    width: 0,
    height: 0,
    deviceScaleFactor: emulation.dpr,
    mobile: emulation.mobile,
    screenWidth: emulation.width,
    screenHeight: emulation.height,
    screenOrientation: {
      type: landscape ? 'landscapePrimary' : 'portraitPrimary',
      angle: landscape ? 90 : 0,
    },
  })
  await debuggerCommand(
    guest,
    'Emulation.setTouchEmulationEnabled',
    emulation.touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false },
  )
}

async function stopEmulating(guest: Electron.WebContents): Promise<void> {
  await debuggerCommand(guest, 'Emulation.clearDeviceMetricsOverride')
  await debuggerCommand(guest, 'Emulation.setTouchEmulationEnabled', { enabled: false })
}

export async function applyGuestDevice(
  guest: Electron.WebContents,
  device: BrowserDevice | null,
  base: UserAgentMetadata,
): Promise<boolean> {
  const emulation = device ? deviceEmulation(device, base) : null
  const before = identities.get(guest) ?? DESKTOP
  const identity = identityOf(emulation)
  try {
    if (emulation) await emulate(guest, emulation)
    else await stopEmulating(guest)
  } catch {
    return false
  }
  identities.set(guest, identity)
  if (emulation) emulations.set(guest, emulation)
  else emulations.delete(guest)
  setDeviceAgent(guest.id, emulation?.agent ?? null)
  if (identity !== before && guest.getURL()) guest.reload()
  return true
}

export function dispatchDeviceTouch(
  guest: Electron.WebContents,
  input: DeviceTouch,
  hostZoom: number,
): void {
  if (!emulations.get(guest)?.touch) return
  if (input.type === 'wheel') {
    guest.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(input.viewX * hostZoom),
      y: Math.round(input.viewY * hostZoom),
      deltaX: -input.deltaX,
      deltaY: -input.deltaY,
    })
    return
  }
  const ended = input.type === 'touchEnd' || input.type === 'touchCancel'
  const at = { x: input.windowX * hostZoom, y: input.windowY * hostZoom }
  debuggerCommand(guest, 'Input.dispatchTouchEvent', {
    type: input.type,
    touchPoints: ended ? [] : [at],
  }).catch(() => {})
}

export function registerDeviceIpc(
  browserPanes: Map<string, number>,
  baseMetadata: UserAgentMetadata,
): void {
  ipcMain.handle('browser:set-device', (e, paneId: string, raw: unknown) => {
    const guest = ownedGuest(browserPanes, paneId, String(e.sender.id))
    if (!guest) return false
    const device = raw === null ? null : parseBrowserDevice(raw)
    if (device === undefined) return false
    return applyGuestDevice(guest, device, baseMetadata)
  })
  ipcMain.on('browser:device-touch', (e, paneId: string, raw: unknown) => {
    const guest = ownedGuest(browserPanes, paneId, String(e.sender.id))
    const input = parseDeviceTouch(raw)
    if (guest && input) dispatchDeviceTouch(guest, input, e.sender.getZoomFactor())
  })
}
