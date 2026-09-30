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
  dismissBlocked: () => void
  load: (workspaceId: string) => Promise<void>
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<void>
  notePane: (paneId: string, sandboxed: boolean) => void
  restart: (paneId: string) => Promise<void>
}

export const useSandboxStore = create<SandboxState>((set) => ({
  enabled: {},
  paneSandboxed: {},
  generation: {},
  blocked: null,
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
  state: Pick<SandboxState, 'enabled' | 'paneSandboxed'>,
  workspaceId: string,
  paneId: string,
): boolean {
  const pane = state.paneSandboxed[paneId]
  const workspace = state.enabled[workspaceId]
  return pane !== undefined && workspace !== undefined && pane !== workspace
}
