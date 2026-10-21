import { create } from 'zustand'
import {
  instanceKey,
  keepInstance,
  type PanelInstance,
  sameInstance,
} from '@/lib/panes/panelKeepAlive'

export interface PanelRoute {
  path: string
  seq: number
}

interface ShowOptions {
  workspaceId?: string
  path?: string
}

interface SidePanelState {
  right: string | null
  kept: PanelInstance[]
  routes: Record<string, PanelRoute>
  revealed: string[]
  showRight: (extId: string, options?: ShowOptions) => void
  toggleRight: (extId: string) => void
  hideRight: () => void
  keep: (instance: PanelInstance) => void
  reveal: (instance: PanelInstance) => void
  drop: (extId: string) => void
  forgetWorkspaces: (live: ReadonlySet<string>) => void
  unload: (workspaceId: string) => void
}

let routeSeq = 0

export const useSidePanelStore = create<SidePanelState>((set) => ({
  right: null,
  kept: [],
  routes: {},
  revealed: [],
  showRight: (extId, { workspaceId, path } = {}) =>
    set((s) => ({
      right: extId,
      routes:
        workspaceId && path
          ? { ...s.routes, [instanceKey({ extId, workspaceId })]: { path, seq: ++routeSeq } }
          : s.routes,
    })),
  toggleRight: (extId) => set((s) => ({ right: s.right === extId ? null : extId })),
  hideRight: () => set({ right: null }),
  keep: (instance) =>
    set((s) => {
      const kept = keepInstance(s.kept, instance)
      const same = kept.length === s.kept.length && kept.every((k, i) => sameInstance(k, s.kept[i]))
      return same ? s : { kept }
    }),
  reveal: (instance) =>
    set((s) => {
      const key = instanceKey(instance)
      return s.revealed.includes(key) ? s : { revealed: [...s.revealed, key] }
    }),
  forgetWorkspaces: (live) =>
    set((s) => {
      const kept = s.kept.filter((i) => live.has(i.workspaceId))
      if (kept.length === s.kept.length) return s
      return {
        kept,
        revealed: s.revealed.filter((key) => live.has(key.slice(key.indexOf('\n') + 1))),
        routes: Object.fromEntries(
          Object.entries(s.routes).filter(([key]) => live.has(key.slice(key.indexOf('\n') + 1))),
        ),
      }
    }),
  unload: (workspaceId) =>
    set((s) => ({
      kept: s.kept.filter((i) => i.workspaceId !== workspaceId),
      revealed: s.revealed.filter((key) => key.slice(key.indexOf('\n') + 1) !== workspaceId),
    })),
  drop: (extId) =>
    set((s) => ({
      right: s.right === extId ? null : s.right,
      kept: s.kept.filter((i) => i.extId !== extId),
    })),
}))
