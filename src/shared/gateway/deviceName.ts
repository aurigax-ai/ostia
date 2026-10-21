export const DEVICE_NAME_MAX = 64

export function cleanDeviceName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim().slice(0, DEVICE_NAME_MAX).trim()
  return trimmed || null
}
