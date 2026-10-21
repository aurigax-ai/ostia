import { DotsThreeIcon, PlusIcon, UserCircleIcon } from '@phosphor-icons/react'
import {
  type ClaudeAccountView,
  DEFAULT_ACCOUNT,
  type RemoveAccountOutcome,
} from '@shared/claudeAccounts/claudeAccounts'
import { useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { Notice } from '@/components/common/Notice'
import { SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useClaudeAccounts } from '@/lib/agents/useClaudeAccounts'
import { fmt, useDict } from '@/lib/app/useDict'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

type Problem = 'no-workspace' | 'not-opened' | 'running' | null

const accountName = (account: ClaudeAccountView, fallback: string): string =>
  account.email ?? fallback

export function ClaudeAccountsSection(): JSX.Element {
  const d = useDict().claudeAccounts
  const { accounts, current, adding, duplicate, damaged } = useClaudeAccounts()
  const { claudeAccounts } = window.ostia
  const [problem, setProblem] = useState<Problem>(null)
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null)

  const add = async (): Promise<void> => {
    const outcome = await claudeAccounts.add(useWorkspacesStore.getState().activeWorkspaceId)
    setProblem(outcome === 'no-workspace' || outcome === 'not-opened' ? outcome : null)
  }
  const remove = async (account: ClaudeAccountView): Promise<void> => {
    setRemoving(null)
    const outcome: RemoveAccountOutcome = await claudeAccounts.remove(account.id)
    setProblem(outcome === 'running' ? 'running' : null)
  }
  const problemText = {
    'no-workspace': d.addNoWorkspace,
    'not-opened': d.addNotOpened,
    running: d.removeRunning,
  }

  return (
    <SettingsPage
      title={d.title}
      desc={d.titleDesc}
      actions={
        <Button variant="outline" size="sm" disabled={adding || damaged} onClick={() => void add()}>
          <PlusIcon aria-hidden />
          {d.add}
        </Button>
      }
    >
      {damaged ? (
        <Notice
          actions={
            <Button variant="ghost" size="sm" onClick={() => void claudeAccounts.startFresh()}>
              {d.damagedFresh}
            </Button>
          }
        >
          {d.damaged}
        </Notice>
      ) : null}
      {adding ? <Notice tone="info">{d.adding}</Notice> : null}
      {duplicate ? <Notice tone="info">{fmt(d.duplicate, { email: duplicate })}</Notice> : null}
      {problem ? <Notice>{problemText[problem]}</Notice> : null}
      <SettingsList label={d.listLabel} empty={d.defaultAccount}>
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            active={account.id === current}
            onRemove={() => setRemoving(account)}
          />
        ))}
      </SettingsList>
      <div className="mt-4">
        <SettingsSubgroup title={d.sharedTitle} desc={d.sharedDesc} />
      </div>
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fmt(d.removeTitle, {
                account: removing ? accountName(removing, d.defaultAccount) : '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{d.removeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{d.cancel}</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => removing && void remove(removing)}
            >
              {d.remove}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  )
}

function AccountRow({
  account,
  active,
  onRemove,
}: {
  account: ClaudeAccountView
  active: boolean
  onRemove: () => void
}): JSX.Element {
  const d = useDict().claudeAccounts
  const name = accountName(account, d.defaultAccount)
  const removable = account.id !== DEFAULT_ACCOUNT
  const meta = [account.id === DEFAULT_ACCOUNT ? d.defaultLabel : null, active ? d.active : null]
  let actions: React.ReactNode = null
  if (active && removable) {
    actions = (
      <Button variant="ghost" size="sm" onClick={onRemove}>
        {d.remove}
      </Button>
    )
  } else if (!active) {
    actions = (
      <DropdownMenu
        trigger={<IconButton icon={DotsThreeIcon} label={fmt(d.actionsFor, { account: name })} />}
      >
        <MenuItem onClick={() => void window.ostia.claudeAccounts.use(account.id)}>
          {d.switchTo}
        </MenuItem>
        {removable ? <MenuItem onClick={onRemove}>{d.remove}</MenuItem> : null}
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
