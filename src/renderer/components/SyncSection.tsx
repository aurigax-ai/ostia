import { PRODUCT_NAME } from '@shared/product'
import type { SyncStatus } from '@shared/types'
import { useEffect, useMemo, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { ControlRow, SectionHead } from './SettingsPanel'
import { Button } from './ui/button'
import { Separator } from './ui/separator'

const OFF: SyncStatus = { dir: null, state: 'off', lastSync: null, lastConflict: null }

export function syncErrorText(d: Dict, error: string | undefined): string {
  if (error === 'missing') return d.sync.errMissing
  if (error === 'not-a-directory') return d.sync.errNotDir
  if (error === 'same-as-local') return fmt(d.sync.errSame, { app: PRODUCT_NAME })
  if (error?.startsWith('invalid-json:')) {
    return fmt(d.sync.errInvalid, { files: error.slice('invalid-json:'.length) })
  }
  return fmt(d.sync.errUnknown, { error: error ?? '' })
}

export function SyncSection(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const dir = useSettingsStore((s) => s.sync?.dir ?? '')
  const setSyncDir = useSettingsStore((s) => s.setSyncDir)
  const [status, setStatus] = useState<SyncStatus>(OFF)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.pine.sync.status().then((s) => {
      if (live) setStatus(s)
    })
    const off = window.pine.sync.onStatus((s) => setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])

  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  )

  const syncNow = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.pine.sync.run())
    } finally {
      setBusy(false)
    }
  }

  const choose = async (): Promise<void> => {
    const picked = await window.pine.sync.pickFolder()
    if (!picked) return
    await setSyncDir(picked)
    await syncNow()
  }

  const stop = async (): Promise<void> => {
    await setSyncDir('')
    setStatus(OFF)
  }

  const statusText = !dir
    ? d.sync.off
    : status.state === 'error'
      ? syncErrorText(d, status.error)
      : status.lastSync
        ? fmt(d.sync.lastSync, { time: time.format(new Date(status.lastSync)) })
        : d.sync.never

  return (
    <div>
      <SectionHead title={d.sync.title} />
      <p className="mb-3 text-fg-muted text-ui-sm">{d.sync.desc}</p>
      <Separator className="mb-2" />
      <ControlRow label={d.sync.folder} desc={fmt(d.sync.folderDesc, { app: PRODUCT_NAME })}>
        <span className="max-w-60 truncate font-mono text-fg-muted text-ui-sm" title={dir}>
          {dir || d.sync.notSet}
        </span>
        <Button variant="outline" size="sm" onClick={() => void choose()}>
          {d.sync.choose}
        </Button>
        {dir ? (
          <Button variant="ghost" size="sm" onClick={() => void stop()}>
            {d.sync.stop}
          </Button>
        ) : null}
      </ControlRow>
      <ControlRow label={d.sync.status}>
        <output
          className={`text-ui-sm ${status.state === 'error' && dir ? 'text-attn-fg' : 'text-fg-muted'}`}
        >
          {statusText}
        </output>
        <Button variant="outline" size="sm" disabled={!dir || busy} onClick={() => void syncNow()}>
          {d.sync.now}
        </Button>
      </ControlRow>
      {dir && status.lastConflict ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {fmt(d.sync.conflict, {
            time: time.format(new Date(status.lastConflict.at)),
            files: status.lastConflict.files.join(', '),
          })}
        </p>
      ) : null}
    </div>
  )
}
