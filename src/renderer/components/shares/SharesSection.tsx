import type { ShareView } from '@shared/artifacts/shares'
import { useEffect, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { DATE_ONLY, formatBytes, formatDate } from '@/lib/app/localeFormat'
import { useCopied } from '@/lib/app/useCopied'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useSharesStore } from '@/stores/files/sharesStore'
import { shareFailureText } from './shareText'

function detailOf(d: ReturnType<typeof useDict>, locale: string, share: ShareView): string {
  const views = share.views === 1 ? d.shares.viewsOne : fmt(d.shares.views, { count: share.views })
  const expiry = share.expired
    ? d.shares.expired
    : share.expiresAt === 0
      ? d.shares.doneNever
      : fmt(d.shares.expires, { date: formatDate(share.expiresAt, locale, DATE_ONLY) })
  return [d.shares.modeText[share.mode], formatBytes(share.size, locale), views, expiry].join(' · ')
}

function ShareRow({ share }: { share: ShareView }): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [copied, markCopied] = useCopied()
  const [problem, setProblem] = useState<string | null>(null)

  const copy = async (): Promise<void> => {
    const result = await window.ostia.shares.copyLink(share.id)
    if (result.ok) markCopied()
    setProblem(result.ok ? null : shareFailureText(d, result.error))
  }

  const remove = async (): Promise<void> => {
    const result = await useSharesStore.getState().remove(share.id)
    setProblem(result.ok ? null : shareFailureText(d, result.error))
  }

  return (
    <SettingsListRow
      title={share.name ?? share.url}
      meta={share.uploaded ? undefined : d.shares.neverUploaded}
      detail={detailOf(d, locale, share)}
      below={problem ? <Notice tone="error">{problem}</Notice> : null}
      actions={
        <>
          {share.linkable && !share.expired ? (
            <Button variant="outline" size="xs" onClick={() => void copy()}>
              {copied ? d.shares.copied : d.shares.copyLink}
            </Button>
          ) : null}
          <Button variant="outline" size="xs" onClick={() => void remove()}>
            {d.shares.delete}
          </Button>
        </>
      }
    />
  )
}

export function SharesSection(): JSX.Element {
  const d = useDict()
  const { availability, shares, error, loaded } = useSharesStore()
  useEffect(() => {
    void useSharesStore.getState().refresh()
  }, [])

  const signedOut = availability?.state === 'signed-out' || error === 'signed-out'
  return (
    <SettingsPage title={d.shares.title} desc={d.shares.desc}>
      {signedOut ? (
        <ControlRow label={d.shares.title} desc={d.shares.signedOut}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => useUIStore.getState().openSettings('server')}
          >
            {d.shares.signedOutOpen}
          </Button>
        </ControlRow>
      ) : null}
      {!signedOut && error ? <Notice>{shareFailureText(d, error)}</Notice> : null}
      {!signedOut && !error && availability?.state === 'off' ? (
        <Notice>{d.shares.errPublishOff}</Notice>
      ) : null}
      {!signedOut && loaded && !error ? (
        <SettingsList label={d.shares.title} empty={d.shares.empty}>
          {shares.map((share) => (
            <ShareRow key={share.id} share={share} />
          ))}
        </SettingsList>
      ) : null}
    </SettingsPage>
  )
}
