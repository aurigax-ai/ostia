import { SectionHead, SettingsGroup } from '@/components/settings/SettingsGroup'
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
import { readPref, writePref } from '@/lib/app/localPrefs'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { PlusIcon, WarningIcon } from '@phosphor-icons/react'
import type {
  ScriptTokenInfo,
  ScriptTokenSaveResult,
  ScriptTokensState,
} from '@shared/permissions/scriptTokens'
import { useMemo, useState } from 'react'
import { CodeBlock, type Shown, ShownDialog } from './ShownDialog'
import { TokenDetail } from './TokenDetail'
import { TokenDialog } from './TokenDialog'
import { TokenRow } from './TokenRow'
import { ENV, EXAMPLE } from './tokenText'
import { useScriptTokens, useTokenUsage } from './useScriptTokens'

const DISMISSED_KEY = 'scriptTokens.retiredDismissedAt'

function RetiredBanner({
  state,
  onDismiss,
}: {
  state: ScriptTokensState
  onDismiss: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <output className="mb-4 flex items-start gap-3 rounded-md border border-warn-fg/40 bg-warn-fg/10 px-3 py-2.5 text-warn-fg">
      <WarningIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-ui-sm">
        <div className="font-medium">
          {fmt(d.scriptTokens.retiredTitle, { n: state.retired.length })}
        </div>
        <div>
          {fmt(d.scriptTokens.retiredBody, {
            names: state.retired.map((r) => r.name).join(d.scriptTokens.listSep),
            env: ENV,
          })}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="text-warn-fg" onClick={onDismiss}>
        {d.scriptTokens.dismiss}
      </Button>
    </output>
  )
}

function latestRetired(state: ScriptTokensState): string {
  return state.retired.reduce((max, r) => (r.retiredAt > max ? r.retiredAt : max), '')
}

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
  const [dismissed, setDismissed] = useState(() => {
    const at = readPref(DISMISSED_KEY)
    return typeof at === 'string' ? at : ''
  })

  const usage = useTokenUsage(detailId)

  const tokens = useMemo(
    () => [...state.tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.tokens],
  )
  const detail = detailId ? tokens.find((tk) => tk.id === detailId) : undefined
  const retiredAt = latestRetired(state)
  const showRetired = state.retired.length > 0 && retiredAt > dismissed

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
        <>
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <SectionHead title={t.title} desc={fmt(t.desc, { env: ENV })} />
            </div>
            <Button size="sm" className="shrink-0" onClick={() => setEditing(null)}>
              <PlusIcon data-icon="inline-start" />
              {t.generate}
            </Button>
          </div>
          {showRetired ? (
            <RetiredBanner
              state={state}
              onDismiss={() => {
                writePref(DISMISSED_KEY, retiredAt)
                setDismissed(retiredAt)
              }}
            />
          ) : null}
          {tokens.length === 0 ? (
            <p className="rounded-md border border-line px-3 py-4 text-center text-fg-muted text-ui-sm">
              {t.empty}
            </p>
          ) : (
            <ul aria-label={t.title} className="rounded-md border border-line bg-surface-1">
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
            </ul>
          )}
          {status ? (
            <output className="mt-2 block text-fg-muted text-ui-sm">{status}</output>
          ) : null}
          <div className="mt-6">
            <SettingsGroup title={t.outsideTitle} desc={t.outsideDesc}>
              <CodeBlock lines={[`export ${ENV}=ostia_…`, EXAMPLE]} />
            </SettingsGroup>
          </div>
        </>
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
