import type { UsageCountKind } from '@shared/telemetry'

export function countUsage(kind: UsageCountKind, id: string): void {
  try {
    window.ostia?.telemetry?.count(kind, id)
  } catch {}
}
