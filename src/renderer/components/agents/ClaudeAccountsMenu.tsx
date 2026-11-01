import { GearIcon, UserSwitchIcon } from '@phosphor-icons/react'
import { type ClaudeAccountView, DEFAULT_ACCOUNT } from '@shared/claudeAccounts/claudeAccounts'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem, MenuLabel, MenuRadioItem } from '@/components/common/Menu'
import {
  ContextMenuGroup,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { useClaudeAccounts } from '@/lib/agents/useClaudeAccounts'
import { useDict } from '@/lib/app/useDict'
import { useUIStore } from '@/stores/app/uiStore'
import { useUsageText } from './useUsageText'

const SECTION = 'claudeAccounts'

function AccountMenuRow({ account }: { account: ClaudeAccountView }): JSX.Element {
  const d = useDict().claudeAccounts
  const usage = useUsageText()
  return (
    <MenuRadioItem
      value={account.id}
      closeOnClick
      detail={account.signedOut ? d.signedOut : usage.line(account.usage)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{account.email ?? d.defaultAccount}</span>
        {account.id === DEFAULT_ACCOUNT ? (
          <span className="shrink-0 text-fg-muted text-ui-xs">{d.defaultLabel}</span>
        ) : null}
      </span>
    </MenuRadioItem>
  )
}

export function ClaudeAccountsMenu(): JSX.Element {
  const d = useDict().claudeAccounts
  const { accounts, current, checkUsage } = useClaudeAccounts()
  const openSettings = useUIStore((s) => s.openSettings)
  const checked = useUsageText().checked(accounts)
  return (
    <DropdownMenu
      align="start"
      className={checkUsage ? 'min-w-96' : undefined}
      trigger={<IconButton size="bar" icon={UserSwitchIcon} label={d.menuLabel} />}
    >
      <ContextMenuGroup>
        <MenuLabel>{d.title}</MenuLabel>
        <ContextMenuRadioGroup
          value={current}
          onValueChange={(id) => void window.ostia.claudeAccounts.use(String(id))}
        >
          {accounts
            .filter((account) => account.enabled)
            .map((account) => (
              <AccountMenuRow key={account.id} account={account} />
            ))}
        </ContextMenuRadioGroup>
        {checkUsage && checked ? <MenuLabel>{checked}</MenuLabel> : null}
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <MenuItem icon={GearIcon} onClick={() => openSettings(SECTION)}>
        {d.manage}
      </MenuItem>
    </DropdownMenu>
  )
}
