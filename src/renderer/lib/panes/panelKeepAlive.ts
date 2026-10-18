export const KEEP_ALIVE_MAX = 3

export interface PanelInstance {
  extId: string
  workspaceId: string
}

export function sameInstance(a: PanelInstance, b: PanelInstance): boolean {
  return a.extId === b.extId && a.workspaceId === b.workspaceId
}

export function instanceKey(instance: PanelInstance): string {
  return `${instance.extId}\n${instance.workspaceId}`
}

export function keepInstance(
  kept: readonly PanelInstance[],
  shown: PanelInstance,
  max: number = KEEP_ALIVE_MAX,
): PanelInstance[] {
  const others = kept.filter((i) => !sameInstance(i, shown))
  return [...others.slice(Math.max(0, others.length - (max - 1))), shown]
}
