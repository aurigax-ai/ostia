import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { Dict } from '@shared/app/dict'
import {
  SCRIPT_TOKEN_PRESETS,
  SCRIPT_TOKEN_RUN_CAPS,
  SCRIPT_TOKEN_UI_CAPS,
  type ScriptTokenScope,
  type ScriptTokensState,
  type ScriptTokenUiCap,
} from '@shared/permissions/scriptTokens'
import { fmt } from '@/lib/app/useDict'

type Preset = keyof typeof SCRIPT_TOKEN_PRESETS | 'custom'

export function shownCaps(caps: readonly Capability[]): ScriptTokenUiCap[] {
  return SCRIPT_TOKEN_UI_CAPS.filter((cap) => caps.includes(cap))
}

export function runsCommands(caps: readonly Capability[]): boolean {
  return caps.some((cap) => SCRIPT_TOKEN_RUN_CAPS.includes(cap))
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v))
}

export function presetOf(caps: readonly Capability[]): Preset {
  if (sameSet(caps, SCRIPT_TOKEN_PRESETS.readonly)) return 'readonly'
  if (sameSet(caps, SCRIPT_TOKEN_PRESETS.coordinator)) return 'coordinator'
  return 'custom'
}

export function sameScope(a: ScriptTokenScope, b: ScriptTokenScope): boolean {
  if (a.kind === 'all' || b.kind === 'all') return a.kind === b.kind
  return (
    sameSet(a.groups, b.groups) &&
    sameSet(a.workspaces, b.workspaces) &&
    a.ownWorkspaces === b.ownWorkspaces
  )
}

export function knownScope(scope: ScriptTokenScope, state: ScriptTokensState): ScriptTokenScope {
  if (scope.kind === 'all') return scope
  return {
    kind: 'limited',
    groups: scope.groups.filter((id) => state.groups.some((g) => g.id === id)),
    workspaces: scope.workspaces.filter((id) => state.workspaces.some((w) => w.id === id)),
    ownWorkspaces: scope.ownWorkspaces,
  }
}

export function groupSize(groupId: string, state: ScriptTokensState): number {
  return state.workspaces.filter((w) => w.groupId === groupId).length
}

export function reachedCount(scope: ScriptTokenScope, state: ScriptTokensState): number {
  if (scope.kind === 'all') return state.workspaces.length
  return state.workspaces.filter(
    (w) => scope.workspaces.includes(w.id) || (w.groupId && scope.groups.includes(w.groupId)),
  ).length
}

export function reachText(d: Dict, caps: readonly Capability[], n: number): string {
  return fmt(runsCommands(caps) ? d.scriptTokens.reachRun : d.scriptTokens.reachRead, { n })
}
