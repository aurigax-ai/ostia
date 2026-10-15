const TOUCH_TYPES = ['touchStart', 'touchMove', 'touchEnd', 'touchCancel'] as const

type DeviceTouchType = (typeof TOUCH_TYPES)[number]

export type DeviceTouch =
  | { type: DeviceTouchType; windowX: number; windowY: number }
  | { type: 'wheel'; viewX: number; viewY: number; deltaX: number; deltaY: number }

function finite(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isFinite(raw)
}

export function parseDeviceTouch(raw: unknown): DeviceTouch | null {
  if (!raw || typeof raw !== 'object') return null
  const { type, windowX, windowY, viewX, viewY, deltaX, deltaY } = raw as Record<string, unknown>
  if (type === 'wheel') {
    return finite(viewX) && finite(viewY) && finite(deltaX) && finite(deltaY)
      ? { type, viewX, viewY, deltaX, deltaY }
      : null
  }
  const touchType = TOUCH_TYPES.find((known) => known === type)
  return touchType && finite(windowX) && finite(windowY)
    ? { type: touchType, windowX, windowY }
    : null
}
