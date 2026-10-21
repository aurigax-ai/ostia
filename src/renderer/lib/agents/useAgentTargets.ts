import type { ResumableAgent } from '@shared/agents/agentResume'
import type { Dict } from '@shared/app/dict'
import { useEffect, useMemo } from 'react'
import { sessionTitle } from '@/lib/agents/agentSession'
import { runningAgent } from '@/lib/agents/paneAgent'
import { type PickTarget, pickTargets } from '@/lib/agents/pickTargets'
import { fmt, useDict } from '@/lib/app/useDict'
import { groupMates, groupPeerIds } from '@/lib/sidebar/groupPeers'
import { useAgentGroupsStore } from '@/stores/agents/agentGroupsStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useOriginAgentsStore } from '@/stores/agents/originAgentsStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRecencyStore } from '@/stores/workspaces/paneRecencyStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function agentLabel(d: Dict, title: string, agent: ResumableAgent | 'other'): string {
  if (agent === 'other') return title
  const name = d.agentSession[agent]
  const session = sessionTitle(title, agent)
  return session ? `${name} · ${session}` : name
}

function useWindowAgentTargets(workspaceId: string): PickTarget[] {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const layouts = useLayoutStore((s) => s.byWorkspace)
  const attention = useAttentionStore((s) => s.byPane)
  const touchedAt = usePaneRecencyStore((s) => s.touchedAt)
  const running = useBlocksStore((s) => s.running)
  const agentBlocks = useBlocksStore((s) => s.agentBlocks)
  return useMemo(() => {
    void running
    void agentBlocks
    return pickTargets({
      workspaces,
      layouts,
      sourceWorkspaceId: workspaceId,
      attention,
      touchedAt,
    }).flatMap((target) => {
      const agent = runningAgent(target.paneId)
      return agent ? [{ ...target, title: agentLabel(d, target.title, agent) }] : []
    })
  }, [workspaces, layouts, workspaceId, attention, touchedAt, running, agentBlocks, d])
}

export function useLocalAgentTargets(workspaceId: string): PickTarget[] {
  const inWindow = useWindowAgentTargets(workspaceId)
  return useMemo(() => inWindow.filter((target) => target.sameWorkspace), [inWindow])
}

function useGroupPeerIds(workspaceId: string): string[] {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const sandboxed = useSandboxStore((s) => s.enabled)
  const agentPlacements = useAgentGroupsStore((s) => s.placements)
  const unknown = groupMates(workspaces, workspaceId)
    .filter((w) => sandboxed[w.id] === undefined)
    .map((w) => w.id)
    .join('\n')
  useEffect(() => {
    for (const id of unknown ? unknown.split('\n') : []) void useSandboxStore.getState().load(id)
  }, [unknown])
  return useMemo(
    () => groupPeerIds({ workspaces, workspaceId, sandboxed, agentPlacements }),
    [workspaces, workspaceId, sandboxed, agentPlacements],
  )
}

export function useAgentTargets(workspaceId: string): PickTarget[] {
  const d = useDict()
  const inWindow = useWindowAgentTargets(workspaceId)
  const peers = useGroupPeerIds(workspaceId)
  const origin = useOriginAgentsStore((s) => s.byWorkspace[workspaceId])
  return useMemo(() => {
    const local = inWindow.filter((target) => target.sameWorkspace)
    const grouped = inWindow
      .filter((target) => peers.includes(target.workspaceId))
      .map((target) => ({
        ...target,
        title: fmt(d.send.groupTarget, { agent: target.title, workspace: target.workspaceName }),
      }))
    if (!origin) return [...local, ...grouped]
    const remote = origin.targets.map(
      (target): PickTarget => ({
        paneId: target.paneId,
        workspaceId: origin.workspaceId,
        workspaceName: origin.workspaceName,
        title: fmt(d.send.originTarget, {
          agent: agentLabel(d, target.title, target.agent),
          workspace: origin.workspaceName,
        }),
        ...(target.cwd ? { cwd: target.cwd } : {}),
        state: target.state,
        sameWorkspace: false,
        via: workspaceId,
      }),
    )
    return [...local, ...grouped, ...remote]
  }, [inWindow, peers, origin, workspaceId, d])
}

export function useNoAgentsText(workspaceId: string): string {
  const d = useDict()
  const origin = useOriginAgentsStore((s) => s.byWorkspace[workspaceId])
  const peers = useGroupPeerIds(workspaceId)
  if (origin === undefined) return peers.length > 0 ? d.send.noGroupTargets : d.send.noTargets
  if (origin === null) return d.send.originGone
  return fmt(d.send.noOriginTargets, { workspace: origin.workspaceName })
}
