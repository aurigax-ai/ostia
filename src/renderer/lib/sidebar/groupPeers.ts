import type { WorkspaceKind } from '@/stores/workspacesStore'
import type { AgentGroupPlacement } from '@shared/permissions/reach'

export interface GroupMember {
  id: string
  kind: WorkspaceKind
  groupId?: string
}

export interface GroupPeersInput {
  workspaces: readonly GroupMember[]
  workspaceId: string
  sandboxed: Readonly<Record<string, boolean>>
  agentPlacements: readonly AgentGroupPlacement[] | null
}

export function groupMates(workspaces: readonly GroupMember[], workspaceId: string): GroupMember[] {
  const groupId = workspaces.find((w) => w.id === workspaceId)?.groupId
  return groupId ? workspaces.filter((w) => w.groupId === groupId) : []
}

export function groupPeerIds(input: GroupPeersInput): string[] {
  const placements = input.agentPlacements
  if (placements === null) return []
  const shares = (w: GroupMember): boolean =>
    w.kind !== 'scratch' &&
    w.kind !== 'manager' &&
    input.sandboxed[w.id] === false &&
    !placements.some((p) => p.workspaceId === w.id && p.groupId === w.groupId)
  const mates = groupMates(input.workspaces, input.workspaceId)
  const source = mates.find((w) => w.id === input.workspaceId)
  if (!source || !shares(source)) return []
  return mates.filter((w) => w.id !== source.id && shares(w)).map((w) => w.id)
}
