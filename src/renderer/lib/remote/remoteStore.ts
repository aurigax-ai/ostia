import { type RemoteChoice, SETUP_STEPS, type SetupStep } from '@shared/remote/remoteSetup'
import { create } from 'zustand'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { listSshHosts } from '@/lib/workspaces/sshWorkspace'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  attachJob,
  type HostJobs,
  listJobs,
  openRemoteTab,
  runSetupStep,
  stopJob,
} from './remoteApi'

const BLANK: RemoteChoice = { host: '', folder: '~', agent: 'claude' }

const todo = (): SetupStep[] => SETUP_STEPS.map((id) => ({ id, state: 'todo' }))

interface RemoteState {
  mode: 'new' | 'jobs' | null
  hosts: string[]
  choice: RemoteChoice
  steps: SetupStep[] | null
  workspaceId: string | null
  jobs: HostJobs | null | 'loading'
  openNew: () => void
  openJobs: (workspaceId: string | null) => void
  change: (choice: RemoteChoice) => void
  setUp: () => void
  retry: () => void
  check: () => void
  close: () => void
  open: (pane: string) => void
  stop: (pane: string) => void
}

export const useRemoteStore = create<RemoteState>((set, get) => {
  async function run(from: number, check: boolean): Promise<void> {
    const { choice, workspaceId } = get()
    if (!workspaceId) return
    for (let i = from; i < SETUP_STEPS.length; i++) {
      const id = SETUP_STEPS[i]
      set((s) => ({
        steps: s.steps?.map((step, at) => (at === i ? { id, state: 'running' } : step)) ?? null,
      }))
      const result = await runSetupStep(workspaceId, choice, id, check && i === from)
      if (get().mode !== 'new') return
      set((s) => ({ steps: s.steps?.map((step, at) => (at === i ? result : step)) ?? null }))
      if (result.state !== 'done') return
    }
    const opened = await openRemoteTab(workspaceId, choice)
    if (!opened.ok) {
      const failed: SetupStep = {
        id: 'check',
        state: 'failed',
        error: 'runner-stopped',
        detail: opened.message ?? opened.error,
      }
      set((s) => ({ steps: s.steps?.map((step) => (step.id === 'check' ? failed : step)) ?? null }))
      return
    }
    set({ mode: null, steps: null, workspaceId: null })
  }

  function stalledAt(): number {
    return (
      get().steps?.findIndex((step) => step.state === 'failed' || step.state === 'waiting') ?? -1
    )
  }

  return {
    mode: null,
    hosts: [],
    choice: BLANK,
    steps: null,
    workspaceId: null,
    jobs: null,
    openNew: () => {
      set({ mode: 'new', steps: null, workspaceId: null, choice: BLANK })
      void listSshHosts().then((found) => {
        const hosts = found?.hosts ?? []
        set((s) => ({
          hosts,
          choice: s.choice.host ? s.choice : { ...s.choice, host: hosts[0] ?? '' },
        }))
      })
    },
    openJobs: (workspaceId) => {
      set({ mode: 'jobs', jobs: 'loading', workspaceId })
      void (workspaceId ? listJobs(workspaceId) : Promise.resolve(null)).then((jobs) => {
        if (get().mode === 'jobs') set({ jobs })
      })
    },
    change: (choice) => set({ choice }),
    setUp: () => {
      const created = startNewWorkspace({ name: get().choice.host })
      if (!created) return
      set({ workspaceId: created, steps: todo() })
      void run(0, false)
    },
    retry: () => {
      const from = stalledAt()
      if (from >= 0) void run(from, false)
    },
    check: () => {
      const from = stalledAt()
      if (from >= 0) void run(from, true)
    },
    close: () => {
      const { mode, workspaceId } = get()
      if (mode === 'new' && workspaceId && !useLayoutStore.getState().byWorkspace[workspaceId]) {
        useWorkspacesStore.getState().closeWorkspace(workspaceId)
      }
      set({ mode: null, steps: null, workspaceId: null, jobs: null })
    },
    open: (pane) => {
      const { workspaceId } = get()
      if (!workspaceId) return
      void attachJob(workspaceId, pane).then(() => get().close())
    },
    stop: (pane) => {
      const { workspaceId } = get()
      if (!workspaceId) return
      void stopJob(workspaceId, pane).then(() => get().openJobs(workspaceId))
    },
  }
})
