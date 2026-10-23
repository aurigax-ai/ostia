import { PlusIcon, UserCircleIcon, UserSwitchIcon } from '@phosphor-icons/react'
import {
  type ClaudeAccountView,
  DEFAULT_ACCOUNT,
  type RemoveAccountOutcome,
} from '@shared/claudeAccounts/claudeAccounts'
import { useState } from 'react'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { ToggleRow } from '@/components/settingsKit/ControlRow'
import { RowRemoveButton } from '@/components/settingsKit/RowRemoveButton'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
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
import { Switch } from '@/components/ui/switch'
import { useClaudeAccounts } from '@/lib/agents/useClaudeAccounts'
import { fmt, useDict } from '@/lib/app/useDict'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ClaudeSignInDialog } from './ClaudeSignInDialog'
import { useUsageText } from './useUsageText'

type Problem = 'no-workspace' | 'not-opened' | 'running' | 'busy' | null

interface SigningIn {
  account: ClaudeAccountView | null
}

const accountName = (account: ClaudeAccountView, fallback: string): string =>
  account.email ?? fallback

export function ClaudeAccountsSection(): JSX.Element {
  const d = useDict().claudeAccounts
  const {
    accounts,
    current,
    adding,
    signInAvailable,
    duplicate,
    damaged,
    recoverable,
    checkUsage,
    usageAvailable,
  } = useClaudeAccounts()
  const { claudeAccounts } = window.ostia
  const [problem, setProblem] = useState<Problem>(null)
  const [broughtBack, setBroughtBack] = useState(0)
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null)
  const [signingIn, setSigningIn] = useState<SigningIn | null>(null)

  const signIn = async (account: ClaudeAccountView | null): Promise<void> => {
    const outcome = await claudeAccounts.beginSignIn(account?.id ?? null)
    setProblem(outcome === 'busy' ? 'busy' : null)
    if (outcome === 'started') setSigningIn({ account })
  }
  const add = async (): Promise<void> => {
    if (signInAvailable) return signIn(null)
    const outcome = await claudeAccounts.add(useWorkspacesStore.getState().activeWorkspaceId)
    setProblem(outcome === 'no-workspace' || outcome === 'not-opened' ? outcome : null)
  }
  const recover = async (): Promise<void> => {
    setBroughtBack((await claudeAccounts.recover()) ?? 0)
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
    busy: d.signInBusy,
  }

  return (
    <SettingsPage
      title={d.title}
      desc={d.titleDesc}
      actions={
        <Button variant="outline" size="sm" disabled={adding || damaged} onClick={() => void add()}>
          <PlusIcon data-icon="inline-start" />
          {d.add}
        </Button>
      }
    >
      {damaged || recoverable > 0 ? (
        <Notice
          actions={
            <Button variant="ghost" size="sm" onClick={() => void recover()}>
              {damaged ? d.damagedFresh : d.recoverBack}
            </Button>
          }
        >
          {damaged
            ? d.damaged
            : recoverable === 1
              ? d.recoverableOne
              : fmt(d.recoverableMany, { count: recoverable })}
        </Notice>
      ) : null}
      {broughtBack > 0 ? (
        <Notice tone="info">
          {broughtBack === 1 ? d.broughtBackOne : fmt(d.broughtBackMany, { count: broughtBack })}
        </Notice>
      ) : null}
      {adding ? <Notice tone="info">{d.adding}</Notice> : null}
      {duplicate ? <Notice tone="info">{fmt(d.duplicate, { email: duplicate })}</Notice> : null}
      {problem ? <Notice>{problemText[problem]}</Notice> : null}
      <SettingsList label={d.listLabel} empty={d.noAccounts}>
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            active={account.id === current}
            onRemove={() => setRemoving(account)}
            onSignIn={() => void signIn(account)}
          />
        ))}
      </SettingsList>
      {usageAvailable ? (
        <SettingsGroup title={d.usageTitle}>
          <ToggleRow
            label={d.checkUsage}
            desc={d.checkUsageDesc}
            checked={checkUsage}
            onChange={(on) => void claudeAccounts.setCheckUsage(on)}
          />
        </SettingsGroup>
      ) : null}
      <SettingsGroup title={d.sharedTitle} desc={d.sharedDesc} />
      {signingIn ? (
        <ClaudeSignInDialog account={signingIn.account} onClose={() => setSigningIn(null)} />
      ) : null}
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

function EmptySlot(): JSX.Element {
  return <span aria-hidden className="size-5.5 shrink-0" />
}

function AccountRow({
  account,
  active,
  onRemove,
  onSignIn,
}: {
  account: ClaudeAccountView
  active: boolean
  onRemove: () => void
  onSignIn: () => void
}): JSX.Element {
  const d = useDict().claudeAccounts
  const usage = useUsageText()
  const name = accountName(account, d.defaultAccount)
  const removable = account.id !== DEFAULT_ACCOUNT
  const meta = [
    account.id === DEFAULT_ACCOUNT ? d.defaultLabel : null,
    active ? d.active : null,
    account.enabled ? null : d.off,
  ]
  let locked: string | null = null
  if (!removable) locked = d.enabledDefault
  else if (active) locked = d.enabledCurrent
  const toggle = (
    <Switch
      checked={account.enabled}
      disabled={locked !== null}
      aria-label={fmt(d.enabledFor, { account: name })}
      onCheckedChange={(on) => void window.ostia.claudeAccounts.setEnabled(account.id, on)}
    />
  )
  const actions = (
    <>
      {active || !account.enabled ? (
        <EmptySlot />
      ) : (
        <IconButton
          icon={UserSwitchIcon}
          label={fmt(d.switchTo, { account: name })}
          onClick={() => void window.ostia.claudeAccounts.use(account.id)}
        />
      )}
      {locked ? (
        <Hint label={locked}>
          <span className="inline-flex">{toggle}</span>
        </Hint>
      ) : (
        toggle
      )}
      {removable ? (
        <RowRemoveButton label={fmt(d.removeFor, { account: name })} onClick={onRemove} />
      ) : (
        <EmptySlot />
      )}
    </>
  )
  return (
    <SettingsListRow
      lead={<UserCircleIcon aria-hidden className="size-4" />}
      title={name}
      meta={meta.filter(Boolean).join(' · ') || undefined}
      detail={
        account.signedOut ? (
          <>
            {d.signedOut} ·{' '}
            <TextLink size="xs" onClick={onSignIn}>
              {d.signInAgain}
            </TextLink>
          </>
        ) : (
          usage.line(account.usage)
        )
      }
      actions={actions}
    />
  )
}
