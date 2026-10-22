import { CheckIcon, UserSwitchIcon } from '@phosphor-icons/react'
import { DEFAULT_ACCOUNT } from '@shared/claudeAccounts/claudeAccounts'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem, MenuLabel } from '@/components/common/Menu'
import { TextLink } from '@/components/common/TextLink'
import { ContextMenuGroup, ContextMenuSeparator } from '@/components/ui/context-menu'
import { useClaudeAccounts } from '@/lib/agents/useClaudeAccounts'
import { useDict } from '@/lib/app/useDict'
import { useUIStore } from '@/stores/app/uiStore'

const SECTION = 'claudeAccounts'

export function ClaudeAccountsMenu(): JSX.Element {
  const d = useDict().claudeAccounts
  const { accounts, current } = useClaudeAccounts()
  const openSettings = useUIStore((s) => s.openSettings)
  return (
    <DropdownMenu
      align="start"
      className="w-80"
      trigger={<IconButton size="bar" icon={UserSwitchIcon} label={d.menuLabel} />}
    >
      <ContextMenuGroup>
        <MenuLabel>{d.title}</MenuLabel>
        {accounts.map((account) => (
          <MenuItem
            key={account.id}
            leading={
              account.id === current ? (
                <CheckIcon aria-label={d.active} className="size-4 text-fg" />
              ) : undefined
            }
            hint={account.id === DEFAULT_ACCOUNT ? d.defaultLabel : undefined}
            onClick={() => void window.ostia.claudeAccounts.use(account.id)}
          >
            {account.email ?? d.defaultAccount}
          </MenuItem>
        ))}
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <div className="flex items-center justify-end px-2 py-1.5 text-ui-xs">
        <TextLink size="xs" onClick={() => openSettings(SECTION)}>
          {d.manage}
        </TextLink>
      </div>
    </DropdownMenu>
  )
}
