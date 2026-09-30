import { create } from 'zustand'

interface SandboxState {
  enabled: Record<string, boolean>
  paneSandboxed: Record<string, boolean>
  generation: Record<string, number>
  load: (workspaceId: string) => Promise<void>
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<void>
  notePane: (paneId: string, sandboxed: boolean) => void
  restart: (paneId: string) => Promise<void>
}

export const useSandboxStore = create<SandboxState>((set) => ({
  enabled: {},
  paneSandboxed: {},
  generation: {},
  load: async (workspaceId) => {
    const settings = await window.pine.sandbox.get(workspaceId)
    if (settings) set((s) => ({ enabled: { ...s.enabled, [workspaceId]: settings.enabled } }))
  },
  setEnabled: async (workspaceId, enabled) => {
    const settings = await window.pine.sandbox.setEnabled(workspaceId, enabled)
    if (settings) set((s) => ({ enabled: { ...s.enabled, [workspaceId]: settings.enabled } }))
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
