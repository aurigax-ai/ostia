import type { BrowseState } from './browseGuests'
import type { BrowseInput, MouseButton } from './browseInput'
import { type BrowseMethod, debuggerCommand, fail, num, str } from './browseMethod'

interface DeviceDeps {
  method: BrowseMethod
  input: BrowseInput
  state: BrowseState
}

export function registerBrowseDeviceMethods(deps: DeviceDeps): void {
  const { method } = deps
  const { mouseMove, mouseButton, zoomed, settle } = deps.input
  const { mousePositions } = deps.state

  method('mouse', async (guest, p) => {
    const button = (str(p.button) ?? 'left') as MouseButton
    if (!['left', 'right', 'middle'].includes(button)) return fail('bad-button', button)
    switch (p.action) {
      case 'move': {
        const x = num(p.x)
        const y = num(p.y)
        if (x === undefined || y === undefined) return fail('coordinates-required')
        mouseMove(guest, x, y)
        break
      }
      case 'down':
        mouseButton(guest, 'mouseDown', button, 1)
        break
      case 'up':
        mouseButton(guest, 'mouseUp', button, 1)
        break
      case 'wheel': {
        const pos = mousePositions.get(guest.id) ?? { x: 0, y: 0 }
        const at = zoomed(guest, pos.x, pos.y)
        guest.sendInputEvent({
          type: 'mouseWheel',
          x: at.x,
          y: at.y,
          deltaX: -(num(p.dx) ?? 0),
          deltaY: -(num(p.dy) ?? 0),
        })
        break
      }
      default:
        return fail('bad-sub', String(p.action))
    }
    await settle(guest)
    return { ok: true }
  })

  method('set', async (guest, p) => {
    switch (p.what) {
      case 'viewport': {
        const width = num(p.width)
        const height = num(p.height)
        if (!width || !height) return fail('size-required')
        await debuggerCommand(guest, 'Emulation.setDeviceMetricsOverride', {
          width: Math.round(width),
          height: Math.round(height),
          deviceScaleFactor: num(p.scale) ?? 0,
          mobile: false,
        })
        return { ok: true }
      }
      case 'media': {
        const features: { name: string; value: string }[] = []
        if (p.colorScheme === 'dark' || p.colorScheme === 'light') {
          features.push({ name: 'prefers-color-scheme', value: p.colorScheme })
        }
        features.push({
          name: 'prefers-reduced-motion',
          value: p.reducedMotion === true ? 'reduce' : '',
        })
        await debuggerCommand(guest, 'Emulation.setEmulatedMedia', { features })
        return { ok: true }
      }
      case 'offline':
        await debuggerCommand(guest, 'Network.emulateNetworkConditions', {
          offline: p.offline === true,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        return { ok: true }
      case 'headers': {
        const headers = p.headers
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
          return fail('headers-required')
        }
        const clean: Record<string, string> = {}
        for (const [k, v] of Object.entries(headers)) clean[k] = String(v)
        await debuggerCommand(guest, 'Network.setExtraHTTPHeaders', { headers: clean })
        return { ok: true }
      }
      case 'geo': {
        const latitude = num(p.latitude)
        const longitude = num(p.longitude)
        if (latitude === undefined || longitude === undefined) return fail('coordinates-required')
        await debuggerCommand(guest, 'Emulation.setGeolocationOverride', {
          latitude,
          longitude,
          accuracy: 1,
        })
        return { ok: true }
      }
      default:
        return fail('unsupported', String(p.what))
    }
  })
}
