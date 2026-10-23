import type { AccountUsage, ClaudeAccountView } from '@shared/claudeAccounts/claudeAccounts'
import { isStale, usageLineParts } from '@/lib/agents/usageLine'
import { useAgoText } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'

const SEPARATOR = ' · '

export function useUsageText(): {
  line: (usage: AccountUsage | null) => string | undefined
  checked: (accounts: readonly ClaudeAccountView[]) => string | undefined
} {
  const d = useDict().claudeAccounts
  const locale = useSettingsStore((s) => s.locale)
  const ago = useAgoText()
  const now = Date.now()
  return {
    line: (usage) => {
      if (!usage) return undefined
      const parts = usageLineParts(usage, now, locale, {
        usageSession: d.usageSession,
        usageWeekly: d.usageWeekly,
        usagePace: d.usagePace,
        usageResets: d.usageResets,
      })
      if (parts.length === 0) return undefined
      if (isStale(usage, now)) parts.push(ago(now - usage.checkedAt))
      return parts.join(SEPARATOR)
    },
    checked: (accounts) => {
      const latest = Math.max(0, ...accounts.map((account) => account.usage?.checkedAt ?? 0))
      return latest > 0 ? fmt(d.usageChecked, { ago: ago(now - latest) }) : undefined
    },
  }
}
