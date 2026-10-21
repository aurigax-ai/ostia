import { ShieldWarningIcon, WarningIcon } from '@phosphor-icons/react'
import type { SyncAttention } from '@shared/profileSync/serverSync'
import { type ReactNode, useState } from 'react'
import { ageText } from '@/components/server/deviceAge'
import { serverErrorText } from '@/components/server/serverText'
import { syncServerErrorText } from '@/components/server/syncServerText'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { refreshSyncAttention, useSyncAttentionStore } from '@/stores/server/syncAttentionStore'
import { CardMeta } from './NeedsYouCard'

interface Actions {
  label: string
  text: string
  warn: boolean
  actions: ReactNode
}

function useActions(item: SyncAttention, fail: (message: string | null) => void): Actions {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const hide = useSyncAttentionStore((s) => s.hide)
  const done = (): void => {
    void refreshSyncAttention()
  }
  const openSettings = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => useUIStore.getState().openSettings('server')}
    >
      {d.syncServer.openServer}
    </Button>
  )
  const deny = (
    <Button variant="ghost" size="sm" onClick={() => hide(item.id)}>
      {d.server.joinDeny}
    </Button>
  )
  switch (item.kind) {
    case 'join':
      return {
        label: d.server.joinLabel,
        warn: false,
        text: fmt(d.server.joinAsks, {
          name: item.name,
          age: ageText(locale, item.createdAt),
          code: item.code,
        }),
        actions: (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.ostia.syncServer.approveJoin(item.deviceId, item.code).then((res) => {
                  fail(res.ok ? null : syncServerErrorText(d, res.error))
                  done()
                })
              }
            >
              {d.server.joinApprove}
            </Button>
            {deny}
          </>
        ),
      }
    case 'approval':
      return {
        label: d.server.approvalLabel,
        warn: false,
        text: fmt(d.server.approvalAsks, {
          name: item.name,
          age: ageText(locale, item.deviceCreatedAt),
        }),
        actions: (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.ostia.server.approve(item.approvalId).then((res) => {
                  fail(res.ok ? null : serverErrorText(d, res.error))
                  done()
                })
              }
            >
              {d.server.approvalApprove}
            </Button>
            {deny}
          </>
        ),
      }
    case 'new-device':
      return {
        label: d.server.newDeviceLabel,
        warn: true,
        text: fmt(d.server.newDeviceWarning, {
          name: item.name,
          age: ageText(locale, item.createdAt),
        }),
        actions: (
          <>
            {openSettings}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.ostia.server.markSeen(item.deviceId).then((res) => {
                  fail(res.ok ? null : serverErrorText(d, res.error))
                  done()
                })
              }
            >
              {d.server.newDeviceMine}
            </Button>
          </>
        ),
      }
    case 'changed':
      return {
        label: d.server.changedLabel,
        warn: true,
        text: fmt(d.syncServer.changedDevices, { devices: item.names.join(', ') }),
        actions: openSettings,
      }
  }
}

export function SyncAttentionCard({ item, at }: { item: SyncAttention; at: number }): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const { label, text, warn, actions } = useActions(item, setError)
  const Icon = warn ? WarningIcon : ShieldWarningIcon
  return (
    <article
      aria-label={label}
      data-sync-attention={item.id}
      className="dashboard-card flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3 text-fg text-ui-sm"
    >
      <CardMeta pane={label} at={at} />
      <div className="flex items-start gap-2">
        <Icon
          size={16}
          aria-hidden
          className={warn ? 'mt-0.5 shrink-0 text-warn-fg' : 'mt-0.5 shrink-0 text-fg-muted'}
        />
        <p className="min-w-0 [overflow-wrap:anywhere]">{text}</p>
      </div>
      {error ? <p className="text-attn-fg text-ui-xs">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
    </article>
  )
}
