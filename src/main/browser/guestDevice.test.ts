import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: {} }))
vi.mock('./signinUserAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./signinUserAgent')>()),
  setDeviceAgent: vi.fn(),
}))

const { DEFAULT_DEVICE, rotated, withPreset } = await import('../../shared/browser/browserDevice')
const { applyGuestDevice, deviceEmulation, dispatchDeviceTouch, inDeviceMode } = await import(
  './guestDevice'
)
const { electronAgentMetadata, setDeviceAgent } = await import('./signinUserAgent')

const BASE = electronAgentMetadata({
  chromeVersion: '152.0.7977.130',
  platform: 'linux',
  systemVersion: '6.1.0',
  arch: 'x64',
})

let nextId = 1

function fakeGuest(url = 'http://localhost:5173/') {
  const sendCommand = vi.fn(async (_method: string, _params?: object) => ({}))
  const guest = {
    id: nextId++,
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
    getURL: () => url,
    reload: vi.fn(),
  }
  return { guest: guest as unknown as Electron.WebContents, sendCommand, reload: guest.reload }
}

function calls(sendCommand: ReturnType<typeof fakeGuest>['sendCommand']): [string, unknown][] {
  return sendCommand.mock.calls.map(([method, params]) => [method, params])
}

const phone = withPreset(DEFAULT_DEVICE, 'pixel-9')

describe('deviceEmulation', () => {
  it('gives a preset its touch, mobile viewport and agent with the running Chrome and its hints', () => {
    const emulation = deviceEmulation(phone, BASE)
    expect(emulation).toMatchObject({
      width: 412,
      height: 924,
      dpr: 2.625,
      mobile: true,
      touch: true,
    })
    expect(emulation.agent?.userAgent).toContain('Pixel 9) AppleWebKit')
    expect(emulation.agent?.userAgent).toContain('Chrome/152.0.0.0 Mobile')
    expect(emulation.agent?.metadata).toEqual({
      ...BASE,
      platform: 'Android',
      platformVersion: '14',
      architecture: '',
      model: 'Pixel 9',
      mobile: true,
    })
  })

  it('keeps responsive to a size and ratio: desktop agent, mouse, no mobile viewport', () => {
    expect(deviceEmulation({ ...DEFAULT_DEVICE, dpr: 2 }, BASE)).toEqual({
      width: 400,
      height: 800,
      dpr: 2,
      mobile: false,
      touch: false,
      agent: null,
    })
  })
})

describe('applyGuestDevice', () => {
  it('emulates through CDP with the view’s own size, a screen and orientation, touch and its agent', async () => {
    const { guest, sendCommand } = fakeGuest()
    expect(await applyGuestDevice(guest, rotated(phone), BASE)).toBe(true)
    expect(calls(sendCommand)).toEqual([
      [
        'Emulation.setDeviceMetricsOverride',
        {
          width: 0,
          height: 0,
          deviceScaleFactor: 2.625,
          mobile: true,
          screenWidth: 924,
          screenHeight: 412,
          screenOrientation: { type: 'landscapePrimary', angle: 90 },
        },
      ],
      ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }],
    ])
    expect(setDeviceAgent).toHaveBeenLastCalledWith(guest.id, deviceEmulation(phone, BASE).agent)
    expect(inDeviceMode(guest)).toBe(true)
  })

  it('reloads once when the device the page is told it runs on changes, never for a size, turn or zoom', async () => {
    const { guest, reload } = fakeGuest()
    await applyGuestDevice(guest, phone, BASE)
    expect(reload).toHaveBeenCalledTimes(1)
    await applyGuestDevice(guest, rotated(phone), BASE)
    await applyGuestDevice(guest, { ...phone, zoom: 'actual' }, BASE)
    expect(reload).toHaveBeenCalledTimes(1)
    await applyGuestDevice(guest, withPreset(phone, 'iphone-se'), BASE)
    expect(reload).toHaveBeenCalledTimes(2)
    await applyGuestDevice(guest, null, BASE)
    expect(reload).toHaveBeenCalledTimes(3)

    const desk = fakeGuest()
    await applyGuestDevice(desk.guest, DEFAULT_DEVICE, BASE)
    await applyGuestDevice(desk.guest, { ...DEFAULT_DEVICE, width: 900, dpr: 3 }, BASE)
    expect(desk.reload).not.toHaveBeenCalled()
  })

  it('turns off by clearing every override and the agent, and leaves an untouched pane alone', async () => {
    const { guest, sendCommand, reload } = fakeGuest()
    await applyGuestDevice(guest, null, BASE)
    expect(reload).not.toHaveBeenCalled()
    await applyGuestDevice(guest, phone, BASE)
    sendCommand.mockClear()
    await applyGuestDevice(guest, null, BASE)
    expect(calls(sendCommand)).toEqual([
      ['Emulation.clearDeviceMetricsOverride', undefined],
      ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ])
    expect(setDeviceAgent).toHaveBeenLastCalledWith(guest.id, null)
    expect(inDeviceMode(guest)).toBe(false)
  })

  it('answers false and keeps its state when the debugger refuses', async () => {
    const { guest, sendCommand, reload } = fakeGuest()
    sendCommand.mockRejectedValue(new Error('detached'))
    expect(await applyGuestDevice(guest, phone, BASE)).toBe(false)
    expect(inDeviceMode(guest)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload a guest that has no page yet', async () => {
    const { guest, reload } = fakeGuest('')
    await applyGuestDevice(guest, phone, BASE)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('dispatchDeviceTouch', () => {
  it('sends touches in window pixels through CDP and the wheel to the page view, both at host zoom', async () => {
    const { guest, sendCommand } = fakeGuest()
    const sendInputEvent = vi.fn()
    Object.assign(guest, { sendInputEvent })
    await applyGuestDevice(guest, phone, BASE)
    sendCommand.mockClear()
    dispatchDeviceTouch(guest, { type: 'touchStart', windowX: 10, windowY: 20 }, 1.5)
    dispatchDeviceTouch(guest, { type: 'touchMove', windowX: 10, windowY: 4 }, 1.5)
    dispatchDeviceTouch(guest, { type: 'touchEnd', windowX: 10, windowY: 4 }, 1.5)
    dispatchDeviceTouch(guest, { type: 'wheel', viewX: 3, viewY: 5, deltaX: 0, deltaY: 120 }, 2)
    expect(calls(sendCommand)).toEqual([
      ['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 15, y: 30 }] }],
      ['Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 15, y: 6 }] }],
      ['Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }],
    ])
    expect(sendInputEvent).toHaveBeenCalledWith({
      type: 'mouseWheel',
      x: 6,
      y: 10,
      deltaX: -0,
      deltaY: -120,
    })
  })

  it('sends nothing to a pane without a touch device', async () => {
    const { guest, sendCommand } = fakeGuest()
    dispatchDeviceTouch(guest, { type: 'touchStart', windowX: 1, windowY: 1 }, 1)
    await applyGuestDevice(guest, DEFAULT_DEVICE, BASE)
    sendCommand.mockClear()
    dispatchDeviceTouch(guest, { type: 'touchStart', windowX: 1, windowY: 1 }, 1)
    expect(sendCommand).not.toHaveBeenCalled()
  })
})
