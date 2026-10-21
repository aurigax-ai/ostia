import type { Dict } from '@shared/app/dict'
import type {
  BrowserStorageSnapshot,
  StorageCookie,
  StorageEdit,
  StorageKind,
  StorageRemoval,
  StorageWriteResult,
} from '@shared/browser/browserStorage'
import { useCallback, useEffect, useState } from 'react'
import { fmt } from '@/lib/app/useDict'
import { useTransientStatus } from '@/lib/app/useTransientStatus'

export type Editing =
  | { kind: 'cookies'; name: string; value: string; cookie: StorageCookie }
  | { kind: 'local' | 'session'; name: string; value: string }

const STATUS_MS = 4000

export function useBrowserStorage({
  paneId,
  shared,
  refreshKey,
  t,
}: {
  paneId: string
  shared: boolean
  refreshKey: number
  t: Dict['browserStorage']
}) {
  const [kind, setKind] = useState<StorageKind>('cookies')
  const [snapshot, setSnapshot] = useState<BrowserStorageSnapshot | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [status, setStatus] = useTransientStatus(STATUS_MS)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const res = await window.ostia.browser.storageRead(paneId)
    if (res.ok) {
      setSnapshot(res.snapshot)
      setReadError(null)
    } else {
      setReadError(res.error)
    }
  }, [paneId])

  useEffect(() => {
    void refreshKey
    void load()
  }, [load, refreshKey])

  const apply = async (write: Promise<StorageWriteResult>): Promise<boolean> => {
    const res = await write
    if (!res.ok) setStatus(fmt(t.writeFailed, { reason: res.error }))
    await load()
    return res.ok
  }

  const remove = (removal: StorageRemoval): void => {
    void apply(window.ostia.browser.storageRemove(paneId, removal))
  }

  const copy = (name: string, value: string): void => {
    void navigator.clipboard.writeText(value).then(() => setStatus(fmt(t.copied, { name })))
  }

  const save = async (): Promise<void> => {
    if (!editing) return
    const edit: StorageEdit =
      editing.kind === 'cookies'
        ? { kind: 'cookies', cookie: { ...editing.cookie, value: editing.value } }
        : { kind: editing.kind, key: editing.name, value: editing.value }
    if (await apply(window.ostia.browser.storageSet(paneId, edit))) setEditing(null)
  }

  const clearAll = async (): Promise<void> => {
    setConfirmClear(false)
    await apply(window.ostia.browser.storageClear(paneId, kind))
  }

  const origin = snapshot?.origin ?? ''
  const counts: Record<StorageKind, number> = {
    cookies: snapshot?.cookies.length ?? 0,
    local: snapshot?.local.length ?? 0,
    session: snapshot?.session.length ?? 0,
  }
  const clearCopy: Record<StorageKind, { title: string; body: string }> = {
    cookies: {
      title: t.clearCookiesTitle,
      body: shared ? t.clearCookiesSharedBody : t.clearCookiesBody,
    },
    local: {
      title: t.clearLocalTitle,
      body: fmt(shared ? t.clearLocalSharedBody : t.clearLocalBody, { origin }),
    },
    session: { title: t.clearSessionTitle, body: fmt(t.clearSessionBody, { origin }) },
  }

  return {
    kind,
    setKind,
    snapshot,
    readError,
    status,
    query,
    setQuery,
    editing,
    setEditing,
    confirmClear,
    setConfirmClear,
    load,
    remove,
    copy,
    save,
    clearAll,
    origin,
    counts,
    clearCopy,
  }
}
