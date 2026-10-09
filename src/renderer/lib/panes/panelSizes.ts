import { type PanelFraction, clampFraction } from '@/layout/panelSize'

export const PANEL_SIZES_KEY = 'panelSizes'
export const PANEL_SIZES_WRITE_DELAY_MS = 300

const pending = new Map<string, number>()
let writeTimer: ReturnType<typeof setTimeout> | null = null

function readStored(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PANEL_SIZES_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const stored: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const fraction = typeof value === 'number' ? clampFraction(value) : null
      if (fraction !== null) stored[key] = fraction
    }
    return stored
  } catch {
    return {}
  }
}

function writePending(): void {
  writeTimer = null
  if (pending.size === 0) return
  const stored = { ...readStored(), ...Object.fromEntries(pending) }
  pending.clear()
  try {
    window.localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(stored))
  } catch {}
}

export function rememberedPanelFraction(key: string): number | null {
  return pending.get(key) ?? readStored()[key] ?? null
}

export function rememberPanelFractions(fractions: PanelFraction[]): void {
  if (fractions.length === 0) return
  for (const { key, fraction } of fractions) pending.set(key, fraction)
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(writePending, PANEL_SIZES_WRITE_DELAY_MS)
}
