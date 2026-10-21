import { DotsThreeIcon, PlusIcon, UserCircleIcon } from '@phosphor-icons/react'
import { type ClaudeAccountView, DEFAULT_ACCOUNT } from '@shared/claudeAccounts/claudeAccounts'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { Notice } from '@/components/common/Notice'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { useClaudeAccounts } from '@/lib/agents/useClaudeAccounts'
import { fmt, useDict } from '@/lib/app/useDict'

export function AccountsSection(): JSX.Element {
  const d = useDict().claudeAccounts
  const { accounts, current, adding, duplicate } = useClaudeAccounts()
  const { claudeAccounts } = window.ostia
  return (
    <SettingsPage
      title={d.title}
      desc={d.titleDesc}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={adding}
          onClick={() => void claudeAccounts.add()}
        >
          <PlusIcon aria-hidden />
          {d.add}
        </Button>
      }
    >
      {adding ? <Notice tone="info">{d.adding}</Notice> : null}
      {duplicate ? <Notice>{fmt(d.duplicate, { email: duplicate })}</Notice> : null}
      <SettingsList label={d.listLabel} empty={d.defaultAccount}>
        {accounts.map((account) => (
          <AccountRow key={account.id} account={account} active={account.id === current} />
        ))}
      </SettingsList>
      <p className="py-1.5 text-fg-muted text-ui-sm">{d.removeNote}</p>
    </SettingsPage>
  )
}

function AccountRow({
  account,
  active,
}: {
  account: ClaudeAccountView
  active: boolean
}): JSX.Element {
  const d = useDict().claudeAccounts
  const { claudeAccounts } = window.ostia
  const name = account.email ?? d.defaultAccount
  const removable = account.id !== DEFAULT_ACCOUNT
  const remove = (): void => void claudeAccounts.remove(account.id)
  const meta = [account.id === DEFAULT_ACCOUNT ? d.defaultLabel : null, active ? d.active : null]
  let actions: React.ReactNode = null
  if (active && removable) {
    actions = (
      <Button variant="ghost" size="sm" onClick={remove}>
        {d.remove}
      </Button>
    )
  } else if (!active) {
    actions = (
      <DropdownMenu
        trigger={<IconButton icon={DotsThreeIcon} label={fmt(d.actionsFor, { account: name })} />}
      >
        <MenuItem onClick={() => void claudeAccounts.use(account.id)}>{d.switchTo}</MenuItem>
        {removable ? <MenuItem onClick={remove}>{d.remove}</MenuItem> : null}
      </DropdownMenu>
    )
  }
  return (
    <SettingsListRow
      lead={<UserCircleIcon aria-hidden className="size-4" />}
      title={name}
      meta={meta.filter(Boolean).join(' · ') || undefined}
      actions={actions}
    />
  )
}
