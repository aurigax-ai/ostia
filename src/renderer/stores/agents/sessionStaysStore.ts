import { create } from 'zustand'

interface SessionStaysState {
  byPane: Record<string, true>
  show: (paneId: string) => void
  dismiss: (paneId: string) => void
}

export const useSessionStaysStore = create<SessionStaysState>((set) => ({
  byPane: {},
  show: (paneId) => set((s) => ({ byPane: { ...s.byPane, [paneId]: true } })),
  dismiss: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s
      const { [paneId]: _gone, ...rest } = s.byPane
      return { byPane: rest }
    }),
}))

export function startSessionStays(): () => void {
  return window.ostia.claudeAccounts.onSessionStays((paneId) =>
    useSessionStaysStore.getState().show(paneId),
  )
}
