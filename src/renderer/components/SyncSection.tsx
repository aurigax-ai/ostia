import type { Dict } from '@shared/dict'
import type { SyncConflict, SyncStatus } from '@shared/types'
import { useEffect, useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { Hint } from './Hint'
import { ControlRow, SectionHead, WarningNote } from './SettingsPanel'
import { SyncSecretsSection } from './SyncSecretsSection'
import { Button } from './ui/button'
import { Separator } from './ui/separator'

const OFF: SyncStatus = {
  dir: null,
  state: 'off',
  lastSync: null,
  conflicts: [],
  skipped: [],
  heldBack: [],
  offers: [],
  secrets: { state: 'off', logins: false },
}

export function syncErrorText(d: Dict, error: string | undefined): string {
  if (error === 'missing') return d.sync.errMissing
  if (error === 'not-a-directory') return d.sync.errNotDir
  if (error === 'same-as-local') return d.sync.errSame
  if (error === 'unreachable') return d.sync.errUnreachable
  if (error === 'scan-failed') return d.sync.errScan
  if (error === 'busy') return d.sync.errBusy
  if (error?.startsWith('invalid-json:')) {
    return fmt(d.sync.errInvalid, { files: error.slice('invalid-json:'.length) })
  }
  return fmt(d.sync.errUnknown, { error: error ?? '' })
}

function conflictValue(d: Dict, conflict: SyncConflict, value: string | null): string {
  if (conflict.kind === 'secret') return value ?? d.sync.conflictDeleted
  if (conflict.kind === 'file')
    return value === null ? d.sync.conflictDeleted : d.sync.conflictEdited
  return value ?? d.sync.conflictDeleted
}

export function SyncSection(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const dir = useSettingsStore((s) => s.sync?.dir ?? '')
  const setSyncDir = useSettingsStore((s) => s.setSyncDir)
  const [status, setStatus] = useState<SyncStatus>(OFF)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<
    Record<string, { local: string | null; remote: string | null }>
  >({})

  useEffect(() => {
    let live = true
    void window.ostia.sync.status().then((s) => {
      if (live) setStatus(s)
    })
    const off = window.ostia.sync.onStatus((s) => setStatus(s))
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
      setStatus(await window.ostia.sync.run())
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (id: string): Promise<void> => {
    setRevealed(({ [id]: _gone, ...rest }) => rest)
    setStatus(await window.ostia.sync.resolve(id))
  }

  const toggleReveal = async (id: string): Promise<void> => {
    if (revealed[id]) {
      setRevealed(({ [id]: _gone, ...rest }) => rest)
      return
    }
    const res = await window.ostia.sync.secrets.reveal(id)
    if (res.ok) setRevealed((all) => ({ ...all, [id]: { local: res.local, remote: res.remote } }))
  }

  const install = async (id: string): Promise<void> => {
    setInstalling(id)
    try {
      setStatus(await window.ostia.sync.install(id))
    } finally {
      setInstalling(null)
    }
  }

  const choose = async (): Promise<void> => {
    const picked = await window.ostia.sync.pickFolder()
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
      <SectionHead title={d.sync.title} desc={d.sync.desc} />
      <Separator className="mb-2" />
      <ControlRow label={d.sync.folder} desc={d.sync.folderDesc}>
        {dir ? (
          <Hint label={dir}>
            <span className="max-w-60 truncate font-mono text-fg-muted text-ui-sm">{dir}</span>
          </Hint>
        ) : (
          <span className="text-fg-muted text-ui-sm">{d.sync.notSet}</span>
        )}
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
      {dir && status.skipped.length > 0 ? (
        <WarningNote>{fmt(d.sync.skipped, { files: status.skipped.join(', ') })}</WarningNote>
      ) : null}
      {dir && status.heldBack.length > 0 ? (
        <WarningNote>{fmt(d.sync.heldBack, { keys: status.heldBack.join(', ') })}</WarningNote>
      ) : null}
      {dir && status.conflicts.length > 0 ? (
        <section aria-label={d.sync.conflictsTitle} className="mt-4">
          <SectionHead title={d.sync.conflictsTitle} desc={d.sync.conflictsDesc} />
          {status.conflicts.map((conflict) => {
            const shownValues = conflict.kind === 'secret' ? revealed[conflict.id] : conflict
            const kept = shownValues
              ? conflict.winner === 'local'
                ? shownValues.local
                : shownValues.remote
              : null
            const other = shownValues
              ? conflict.winner === 'local'
                ? shownValues.remote
                : shownValues.local
              : null
            const desc =
              conflict.kind === 'secret' && !shownValues
                ? fmt(d.sync.secretChanged, {
                    here: time.format(new Date(conflict.localAt ?? 0)),
                    there: time.format(new Date(conflict.remoteAt ?? 0)),
                  })
                : fmt(d.sync.conflictValues, {
                    kept: conflictValue(d, conflict, kept),
                    other: conflictValue(d, conflict, other),
                  })
            return (
              <ControlRow key={conflict.id} label={conflict.key} desc={desc}>
                {conflict.kind === 'secret' ? (
                  <Button variant="ghost" size="sm" onClick={() => void toggleReveal(conflict.id)}>
                    {shownValues ? d.sync.hide : d.sync.reveal}
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => void resolve(conflict.id)}>
                  {d.sync.useOther}
                </Button>
              </ControlRow>
            )
          })}
        </section>
      ) : null}
      {dir ? <SyncSecretsSection status={status} onStatus={setStatus} /> : null}
      {dir && status.offers.length > 0 ? (
        <section aria-label={d.sync.offersTitle} className="mt-4">
          <SectionHead title={d.sync.offersTitle} desc={d.sync.offersDesc} />
          {status.offers.map((offer) => (
            <ControlRow key={offer.id} label={offer.id} desc={offer.marketplace}>
              <Button
                variant="outline"
                size="sm"
                disabled={installing === offer.id}
                onClick={() => void install(offer.id)}
              >
                {d.sync.install}
              </Button>
            </ControlRow>
          ))}
        </section>
      ) : null}
    </div>
  )
}
