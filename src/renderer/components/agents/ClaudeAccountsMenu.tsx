import { GearIcon, UserSwitchIcon } from '@phosphor-icons/react'
import { type ClaudeAccountView, DEFAULT_ACCOUNT } from '@shared/claudeAccounts/claudeAccounts'
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

const SECTION = 'claudeAccounts'

function AccountMenuRow({ account }: { account: ClaudeAccountView }): JSX.Element {
  const d = useDict().claudeAccounts
  return (
    <MenuRadioItem value={account.id} closeOnClick>
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
  const { accounts, current } = useClaudeAccounts()
  const openSettings = useUIStore((s) => s.openSettings)
  return (
    <DropdownMenu
      align="start"
      trigger={<IconButton size="bar" icon={UserSwitchIcon} label={d.menuLabel} />}
    >
      <ContextMenuGroup>
        <MenuLabel>{d.title}</MenuLabel>
        <ContextMenuRadioGroup
          value={current}
          onValueChange={(id) => void window.ostia.claudeAccounts.use(String(id))}
        >
          {accounts.map((account) => (
            <AccountMenuRow key={account.id} account={account} />
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <MenuItem icon={GearIcon} onClick={() => openSettings(SECTION)}>
        {d.manage}
      </MenuItem>
    </DropdownMenu>
  )
}
