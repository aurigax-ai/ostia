import { PlusIcon } from '@phosphor-icons/react'
import type { ScriptTokenInfo, ScriptTokenSaveResult } from '@shared/permissions/scriptTokens'
import { type JSX, useMemo, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
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
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { CodeBlock, type Shown, ShownDialog } from './ShownDialog'
import { TokenDetail } from './TokenDetail'
import { TokenDialog } from './TokenDialog'
import { TokenRow } from './TokenRow'
import { ENV, EXAMPLE } from './tokenText'
import { useScriptTokens, useTokenUsage } from './useScriptTokens'

export function ScriptTokensSection(): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const locale = useSettingsStore((s) => s.locale)
  const { state, now, reload } = useScriptTokens()
  const [editing, setEditing] = useState<ScriptTokenInfo | null | undefined>(undefined)
  const [shown, setShown] = useState<Shown | null>(null)
  const [revoking, setRevoking] = useState<ScriptTokenInfo | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const usage = useTokenUsage(detailId)

  const tokens = useMemo(
    () => [...state.tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.tokens],
  )
  const detail = detailId ? tokens.find((tk) => tk.id === detailId) : undefined

  const revoke = (token: ScriptTokenInfo): void => {
    setRevoking(null)
    void window.ostia.scriptTokens.revoke(token.id).then((ok) => {
      if (ok) {
        setStatus(fmt(t.revoked, { name: token.name }))
        if (detailId === token.id) setDetailId(null)
      }
      reload()
    })
  }

  const saved = (res: Extract<ScriptTokenSaveResult, { ok: true }>, regenerated: boolean): void => {
    const wasEditing = editing !== null && editing !== undefined
    setEditing(undefined)
    reload()
    if (res.value && regenerated) {
      setShown({
        title: fmt(wasEditing ? t.updatedTitle : t.createdTitle, { name: res.token.name }),
        value: res.value,
        token: res.token,
      })
      setStatus(null)
    } else {
      setStatus(t.renamed)
    }
  }

  return (
    <div>
      {detail ? (
        <TokenDetail
          token={detail}
          state={state}
          usage={usage}
          now={now}
          locale={locale}
          onBack={() => setDetailId(null)}
          onEdit={() => setEditing(detail)}
          onRevoke={() => setRevoking(detail)}
        />
      ) : (
        <SettingsPage
          title={t.title}
          desc={fmt(t.desc, { env: ENV })}
          actions={
            <Button size="sm" onClick={() => setEditing(null)}>
              <PlusIcon data-icon="inline-start" />
              {t.generate}
            </Button>
          }
        >
          <SettingsList label={t.title} empty={t.empty}>
            {tokens.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                state={state}
                now={now}
                locale={locale}
                onEdit={() => setEditing(token)}
                onDetails={() => setDetailId(token.id)}
                onRevoke={() => setRevoking(token)}
              />
            ))}
          </SettingsList>
          {status ? <Notice tone="info">{status}</Notice> : null}
          <SettingsGroup title={t.outsideTitle} desc={t.outsideDesc}>
            <CodeBlock lines={[`export ${ENV}=ostia_…`, EXAMPLE]} />
          </SettingsGroup>
        </SettingsPage>
      )}
      {editing !== undefined ? (
        <TokenDialog
          key={editing?.id ?? 'new'}
          token={editing}
          state={state}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      ) : null}
      {shown ? <ShownDialog shown={shown} state={state} onClose={() => setShown(null)} /> : null}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fmt(t.revokeTitle, { name: revoking?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t.revokeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={() => revoking && revoke(revoking)}
            >
              {t.revoke}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
