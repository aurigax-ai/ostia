import { type AgentResume, parseAgentResume, resumeCommand } from '@shared/agents/agentResume'
import { isAgentBusyReason } from '@shared/agents/agentWork'
import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import type { AttentionState } from '@shared/attention/attention'
import { registerCore } from '@/commands/coreCommand'
import { claudeTrustGate } from '@/lib/agents/folderTrust'
import { forkConversation } from '@/lib/agents/forkConversation'
import {
  hibernateAgentPane,
  type PaneHibernateOutcome,
  wakePane,
} from '@/lib/agents/hibernationScheduler'
import { isStaleAgentReport } from '@/lib/agents/paneAgent'
import {
  claimAcrossWindows,
  claimResume,
  paneResumeHolder,
  resumeHolder,
} from '@/lib/agents/resumeFolder'
import { resumeStarted, watchResumeOutcome } from '@/lib/agents/resumeOutcome'
import { withTypedLaunch } from '@/lib/agents/resumeTyped'
import { postAgentNotification } from '@/lib/attention/agentNotification'
import { announceBusMessage } from '@/lib/attention/busNotice'
import {
  isPaneViewed,
  jumpToLatestUnread,
  signalPane,
  workspaceOfPane,
} from '@/lib/attention/workspaceActivity'
import { findPane } from '@/lib/layout/tree'
import { insertCommand } from '@/lib/terminal/blockActions'
import { requestCloseOtherTabs } from '@/lib/workspaces/closeConfirm'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useAgentTurnStore } from '@/stores/terminal/agentTurnStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHibernateSkippedStore } from '@/stores/workspaces/hibernateSkippedStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useTabSleepNoticeStore } from '@/stores/workspaces/tabSleepNoticeStore'

function registerAttentionCommands(): void {
  registerCore<{ state: AttentionState; message?: string }>({
    id: 'attention.set',
    category: 'pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: ({ state, message }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      if (isStaleAgentReport(ctx.activePaneId, state)) return
      useAgentTurnStore.getState().report(ctx.activePaneId, state)
      const seen = isPaneViewed(ctx.activePaneId)
      signalPane(ctx.activePaneId, { type: 'set', state, message, at: Date.now() })
      if (state === 'waiting' || state === 'done') {
        postAgentNotification(ctx.activePaneId, state, message, seen)
      }
    },
  })

  registerCore<undefined, { state?: AttentionState; message?: string }>({
    id: 'attention.peek',
    category: 'pane',
    hidden: true,
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      const attention = useAttentionStore.getState().byPane[ctx.activePaneId]
      if (!attention || attention.state === 'none') return {}
      return attention.message
        ? { state: attention.state, message: attention.message }
        : { state: attention.state }
    },
  })

  registerCore({
    id: 'attention.typed',
    category: 'pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      useAttentionStore.getState().dispatch(ctx.activePaneId, { type: 'input', at: Date.now() })
    },
  })
}

function registerAgentSessionCommands(): void {
  registerCore<AgentResume>({
    id: 'resume.set',
    category: 'pane',
    hidden: true,
    local: true,
    capabilities: ['drive-self'],
    run: (raw, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      const resume = withTypedLaunch(
        parseAgentResume(raw),
        ctx.activePaneId,
        pane?.kind === 'terminal' ? pane.resume : undefined,
      )
      if (!resume) throw new Error('invalid resume')
      useLayoutStore.getState().setResume(ctx.activeWorkspaceId, ctx.activePaneId, resume)
      useBlocksStore.getState().markAgent(ctx.activePaneId, resume.agent)
      resumeStarted(ctx.activePaneId)
    },
  })

  registerCore<undefined, { resumed: boolean }>({
    id: 'agent.resume',
    category: 'pane',
    capabilities: ['shell'],
    run: async (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) return { resumed: false }
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      if (pane?.kind !== 'terminal' || !pane.resume) return { resumed: false }
      const resume = pane.resume
      const refuseHeld = async (): Promise<void> => {
        const holder =
          resumeHolder(pane.id, resume)?.title ??
          (pane.hibernated || pane.resumeFolderMissing
            ? null
            : await claimAcrossWindows(pane.id, resume))
        if (holder !== null) {
          throw new Error(`${resume.agent} session ${resume.id} is already running in "${holder}"`)
        }
      }
      await refuseHeld()
      if (pane.hibernated) return { resumed: wakePane(pane.id, undefined, !ctx.target) }
      if (pane.resumeFolderMissing) return { resumed: false }
      if (!ctx.target) {
        if (!(await claudeTrustGate(pane.id, resume.agent))) return { resumed: false }
        await refuseHeld()
      }
      const resumed = insertCommand(pane.id, resumeCommand(resume), true)
      if (resumed) {
        claimResume(pane.id, resume)
        watchResumeOutcome(pane.id, resume)
      }
      return { resumed }
    },
  })

  registerCore<undefined, { forked: boolean }>({
    id: 'agent.forkConversation',
    category: 'pane',
    local: true,
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) return { forked: false }
      return { forked: forkConversation(ctx.activeWorkspaceId, ctx.activePaneId) !== null }
    },
  })

  registerCore<undefined, { hibernated: boolean }>({
    id: 'pane.hibernated',
    category: 'pane',
    hidden: true,
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      return { hibernated: pane?.hibernated === true }
    },
  })

  registerCore<undefined, { resume: AgentResume | null }>({
    id: 'pane.resumeToken',
    category: 'pane',
    hidden: true,
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      if (pane?.kind !== 'terminal' || !pane.resume) return { resume: null }
      const { typed: _typed, ...resume } = pane.resume
      return { resume }
    },
  })

  registerCore<{ paneId?: string } | undefined, { woke: boolean; conflict?: string }>({
    id: 'pane.wake',
    category: 'pane',
    capabilities: ['type-other-pane'],
    argsSchema: { type: 'object', properties: { paneId: { type: 'string' } } },
    run: (args, ctx) => {
      const paneId = args?.paneId ?? ctx.activePaneId
      if (!paneId) throw new Error('no target pane')
      const holder = paneResumeHolder(paneId)
      if (holder) {
        if (!ctx.target)
          useTabSleepNoticeStore.getState().show({ kind: 'conflict', tab: holder.title })
        return { woke: false, conflict: holder.title }
      }
      const woke = wakePane(paneId, undefined, !ctx.target)
      if (!woke && !ctx.target) useTabSleepNoticeStore.getState().show({ kind: 'awake' })
      return { woke }
    },
  })

  registerCore<{ paneId?: string } | undefined, { hibernated: boolean; outcome: string }>({
    id: 'pane.hibernate',
    category: 'pane',
    capabilities: ['kill-pane'],
    argsSchema: { type: 'object', properties: { paneId: { type: 'string' } } },
    run: async (args, ctx) => {
      const paneId = args?.paneId ?? ctx.activePaneId
      const workspaceId = paneId ? workspaceOfPane(paneId) : null
      if (!paneId || !workspaceId) throw new Error('no target pane')
      const outcome: PaneHibernateOutcome = await hibernateAgentPane(workspaceId, paneId)
      if (isAgentBusyReason(outcome)) {
        useHibernateSkippedStore.getState().show({ hibernated: [], skipped: { [outcome]: 1 } })
      }
      if (outcome === 'not-agent' && !ctx.target) {
        const layout = useLayoutStore.getState().byWorkspace[workspaceId]
        const asleep = layout ? findPane(layout.root, paneId)?.hibernated === true : false
        useTabSleepNoticeStore.getState().show({ kind: asleep ? 'asleep' : 'notAgent' })
      }
      return { hibernated: outcome === 'hibernated', outcome }
    },
  })
}

function registerCloseOthersAndNoticeCommands(): void {
  registerCore<{ paneId?: string } | undefined>({
    id: 'tab.closeOthers',
    category: 'pane',
    capabilities: ['kill-pane'],
    argsSchema: { type: 'object', properties: { paneId: { type: 'string' } } },
    run: async (args, ctx) => {
      const paneId = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && paneId)
        await requestCloseOtherTabs(ctx.activeWorkspaceId, paneId)
    },
  })

  registerCore<{ message: string }, { desktop: boolean }>({
    id: 'attention.notify',
    category: 'pane',
    hidden: true,
    capabilities: ['notify'],
    run: ({ message }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      const seen = isPaneViewed(ctx.activePaneId)
      signalPane(ctx.activePaneId, { type: 'notify', message, waiting: false, at: Date.now() })
      return {
        desktop: wantsDesktopBanner(useSettingsStore.getState().notifications, 'message', seen),
      }
    },
  })

  registerCore<{ from?: unknown; text?: unknown }>({
    id: 'attention.message',
    category: 'pane',
    hidden: true,
    capabilities: ['notify'],
    run: ({ from, text }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      announceBusMessage(ctx.activePaneId, from, text)
    },
  })

  registerCore<undefined, { paneId: string | null }>({
    id: 'attention.jumpToLatest',
    category: 'view',
    target: 'none',
    run: () => ({ paneId: jumpToLatestUnread() }),
  })
}

export function registerPaneAgentCommands(): void {
  registerAttentionCommands()
  registerAgentSessionCommands()
  registerCloseOthersAndNoticeCommands()
}
