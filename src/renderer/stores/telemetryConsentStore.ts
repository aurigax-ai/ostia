import { DEFAULT_TELEMETRY_SETTINGS, type TelemetrySettings } from '@shared/telemetry'
import { create } from 'zustand'

interface TelemetryConsentState {
  open: boolean
  initial: TelemetrySettings
  show: (initial?: TelemetrySettings) => void
  close: () => void
}

export const useTelemetryConsentStore = create<TelemetryConsentState>((set) => ({
  open: false,
  initial: DEFAULT_TELEMETRY_SETTINGS,
  show: (initial = DEFAULT_TELEMETRY_SETTINGS) => set({ open: true, initial }),
  close: () => set({ open: false }),
}))
