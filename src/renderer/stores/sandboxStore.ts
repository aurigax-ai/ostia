import type { SandboxFolderProblem } from '@shared/sandbox'
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
  refusedFolder: SandboxFolderProblem | null
  stamp: Record<string, string | null>
  paneStamp: Record<string, string>
  hostPanes: Record<string, boolean>
  hostTokens: Record<string, string>
  setHostToken: (paneId: string, token: string) => void
  takeHostToken: (paneId: string) => string | undefined
  noteHost: (paneId: string) => void
  dismissBlocked: () => void
  dismissRefusedFolder: () => void
  load: (workspaceId: string) => Promise<void>
  reloadAll: () => Promise<void>
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<void>
  notePane: (paneId: string, sandboxed: boolean, stamp?: string) => void
  restart: (paneId: string) => Promise<void>
}

export const useSandboxStore = create<SandboxState>((set, get) => ({
  enabled: {},
  paneSandboxed: {},
  generation: {},
  blocked: null,
  refusedFolder: null,
  stamp: {},
  paneStamp: {},
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
  dismissRefusedFolder: () => set({ refusedFolder: null }),
  load: async (workspaceId) => {
    const [settings, stamp] = await Promise.all([
      window.pine.sandbox.get(workspaceId),
      window.pine.sandbox.stamp(workspaceId),
    ])
    if (!settings) return
    set((s) => ({
      enabled: { ...s.enabled, [workspaceId]: settings.enabled },
      stamp: { ...s.stamp, [workspaceId]: stamp },
    }))
  },
  reloadAll: async () => {
    await Promise.all(Object.keys(get().enabled).map((workspaceId) => get().load(workspaceId)))
  },
  setEnabled: async (workspaceId, enabled) => {
    const result = await window.pine.sandbox.setEnabled(workspaceId, enabled)
    if (result.ok) {
      await get().load(workspaceId)
      return
    }
    if (result.reason === 'folder') {
      set({ refusedFolder: result.problem })
      return
    }
    if (result.reason !== 'missing-programs') return
    const report = await window.pine.system.requirements(SANDBOX_FEATURE)
    if (report && report.missing.length > 0) set({ blocked: { workspaceId, report } })
  },
  notePane: (paneId, sandboxed, stamp) =>
    set((s) => {
      if (s.paneSandboxed[paneId] === sandboxed && s.paneStamp[paneId] === stamp) return s
      const { [paneId]: _old, ...paneStamp } = s.paneStamp
      return {
        paneSandboxed: { ...s.paneSandboxed, [paneId]: sandboxed },
        paneStamp: stamp ? { ...paneStamp, [paneId]: stamp } : paneStamp,
      }
    }),
  restart: async (paneId) => {
    if (!(await window.pine.pty.restart(paneId))) return
    set((s) => {
      const { [paneId]: _gone, ...paneSandboxed } = s.paneSandboxed
      const { [paneId]: _stale, ...paneStamp } = s.paneStamp
      return {
        paneSandboxed,
        paneStamp,
        generation: { ...s.generation, [paneId]: (s.generation[paneId] ?? 0) + 1 },
      }
    })
  },
}))

export function needsSandboxRestart(
  state: Pick<SandboxState, 'enabled' | 'paneSandboxed'> &
    Partial<Pick<SandboxState, 'hostPanes' | 'stamp' | 'paneStamp'>>,
  workspaceId: string,
  paneId: string,
): boolean {
  if (state.hostPanes?.[paneId]) return false
  const pane = state.paneSandboxed[paneId]
  const workspace = state.enabled[workspaceId]
  if (pane === undefined || workspace === undefined) return false
  if (pane !== workspace) return true
  const current = state.stamp?.[workspaceId]
  const spawned = state.paneStamp?.[paneId]
  return pane && !!current && !!spawned && current !== spawned
}
