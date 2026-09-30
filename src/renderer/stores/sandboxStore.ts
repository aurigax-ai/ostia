import type { RequirementsReport } from '@shared/systemRequirements'
import { create } from 'zustand'

export const SANDBOX_FEATURE = 'sandbox'

export interface SandboxBlocked {
  workspaceId: string
  report: RequirementsReport
}

interface SandboxState {
  enabled: Record<string, boolean>
  paneSandboxed: Record<string, boolean>
  generation: Record<string, number>
  blocked: SandboxBlocked | null
  hostPanes: Record<string, boolean>
  hostTokens: Record<string, string>
  setHostToken: (paneId: string, token: string) => void
  takeHostToken: (paneId: string) => string | undefined
  noteHost: (paneId: string) => void
  dismissBlocked: () => void
  load: (workspaceId: string) => Promise<void>
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<void>
  notePane: (paneId: string, sandboxed: boolean) => void
  restart: (paneId: string) => Promise<void>
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
  enabled: {},
  paneSandboxed: {},
  generation: {},
  blocked: null,
  hostPanes: {},
  hostTokens: {},
  setHostToken: (paneId, token) =>
    set((s) => ({ hostTokens: { ...s.hostTokens, [paneId]: token } })),
  takeHostToken: (paneId) => {
    const token = get().hostTokens[paneId]
    if (token) {
      set((s) => {
        const { [paneId]: _used, ...rest } = s.hostTokens
        return { hostTokens: rest }
      })
    }
    return token
  },
  noteHost: (paneId) => set((s) => ({ hostPanes: { ...s.hostPanes, [paneId]: true } })),
  dismissBlocked: () => set({ blocked: null }),
  load: async (workspaceId) => {
    const settings = await window.pine.sandbox.get(workspaceId)
    if (settings) set((s) => ({ enabled: { ...s.enabled, [workspaceId]: settings.enabled } }))
  },
  setEnabled: async (workspaceId, enabled) => {
    const settings = await window.pine.sandbox.setEnabled(workspaceId, enabled)
    if (settings) {
      set((s) => ({ enabled: { ...s.enabled, [workspaceId]: settings.enabled } }))
      return
    }
    if (!enabled) return
    const report = await window.pine.system.requirements(SANDBOX_FEATURE)
    if (report && report.missing.length > 0) set({ blocked: { workspaceId, report } })
  },
  notePane: (paneId, sandboxed) =>
    set((s) =>
      s.paneSandboxed[paneId] === sandboxed
        ? s
        : { paneSandboxed: { ...s.paneSandboxed, [paneId]: sandboxed } },
    ),
  restart: async (paneId) => {
    if (!(await window.pine.pty.restart(paneId))) return
    set((s) => {
      const { [paneId]: _gone, ...paneSandboxed } = s.paneSandboxed
      return {
        paneSandboxed,
        generation: { ...s.generation, [paneId]: (s.generation[paneId] ?? 0) + 1 },
      }
    })
  },
}))

export function needsSandboxRestart(
  state: Pick<SandboxState, 'enabled' | 'paneSandboxed'> & Partial<Pick<SandboxState, 'hostPanes'>>,
  workspaceId: string,
  paneId: string,
): boolean {
  if (state.hostPanes?.[paneId]) return false
  const pane = state.paneSandboxed[paneId]
  const workspace = state.enabled[workspaceId]
  return pane !== undefined && workspace !== undefined && pane !== workspace
}
