import type { UsageCategory } from '@shared/privacy/telemetry'

export function countUsage(category: UsageCategory, key: string, id?: string): void {
  try {
    window.ostia?.telemetry?.count(category, key, id)
  } catch {}
}
