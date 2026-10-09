import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { fmt, useDict } from '@/i18n/useDict'
import { cookieRowKey, filterCookies, filterEntries, formatExpiry } from '@/lib/browser/storageRows'
import {
  ArrowClockwiseIcon,
  CheckIcon,
  CopyIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import type {
  BrowserStorageSnapshot,
  StorageCookie,
  StorageEdit,
  StorageEntry,
  StorageKind,
  StorageRemoval,
  StorageWriteResult,
} from '@shared/browser/browserStorage'
import { useCallback, useEffect, useState } from 'react'

type Editing =
  | { kind: 'cookies'; name: string; value: string; cookie: StorageCookie }
  | { kind: 'local' | 'session'; name: string; value: string }

const STATUS_MS = 4000

const DENSE_TABLE = 'text-ui-sm [&_td]:px-2 [&_td]:py-0.5 [&_th]:h-7 [&_th]:px-2'

const VALUE_HINT_MAX = 400

function ValueCell({ value }: { value: string }): JSX.Element {
  if (!value) return <span />
  const hint = value.length > VALUE_HINT_MAX ? `${value.slice(0, VALUE_HINT_MAX)}…` : value
  return (
    <Hint label={hint}>
      <span className="block truncate">{value}</span>
    </Hint>
  )
}

function Flag({ on, label }: { on: boolean; label: string }): JSX.Element | null {
  return on ? <CheckIcon role="img" aria-label={label} className="size-3.5 text-fg" /> : null
}

export function BrowserStoragePanel({
  paneId,
  shared,
  refreshKey,
  onClose,
}: {
  paneId: string
  shared: boolean
  refreshKey: number
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.browserStorage
  const [kind, setKind] = useState<StorageKind>('cookies')
  const [snapshot, setSnapshot] = useState<BrowserStorageSnapshot | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
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

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), STATUS_MS)
    return () => clearTimeout(timer)
  }, [status])

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
  const emptyText: Record<StorageKind, string> = {
    cookies: t.emptyCookies,
    local: t.emptyLocal,
    session: t.emptySession,
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

  const emptyRow = (columns: number, total: number): JSX.Element => (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columns} className="py-3 text-center text-fg-muted text-ui-sm">
        {total === 0 ? emptyText[kind] : fmt(t.noMatch, { filter: query.trim() })}
      </TableCell>
    </TableRow>
  )

  const rowActions = (name: string, value: string, onEdit: () => void, onRemove: () => void) => (
    <div className="flex justify-end gap-0.5">
      <IconButton icon={CopyIcon} label={fmt(t.copy, { name })} onClick={() => copy(name, value)} />
      <IconButton icon={PencilSimpleIcon} label={fmt(t.edit, { name })} onClick={onEdit} />
      <IconButton icon={TrashIcon} label={fmt(t.remove, { name })} onClick={onRemove} />
    </div>
  )

  const cookieTable = (cookies: StorageCookie[]): JSX.Element => {
    const rows = filterCookies(cookies, query)
    return (
      <Table aria-label={t.cookies} className={DENSE_TABLE}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t.name}</TableHead>
            <TableHead>{t.value}</TableHead>
            <TableHead>{t.domain}</TableHead>
            <TableHead>{t.path}</TableHead>
            <TableHead>{t.expires}</TableHead>
            <TableHead>{t.httpOnly}</TableHead>
            <TableHead>{t.secure}</TableHead>
            <TableHead>{t.sameSite}</TableHead>
            <TableHead className="text-right">{t.actions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0
            ? emptyRow(9, cookies.length)
            : rows.map((c) => (
                <TableRow key={cookieRowKey(c)}>
                  <TableCell className="font-mono">{c.name}</TableCell>
                  <TableCell className="max-w-64 font-mono">
                    <ValueCell value={c.value} />
                  </TableCell>
                  <TableCell className="font-mono">{c.domain}</TableCell>
                  <TableCell className="font-mono">{c.path}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatExpiry(c.expires, t.sessionExpiry)}
                  </TableCell>
                  <TableCell>
                    <Flag on={c.httpOnly} label={t.yes} />
                  </TableCell>
                  <TableCell>
                    <Flag on={c.secure} label={t.yes} />
                  </TableCell>
                  <TableCell>{c.sameSite}</TableCell>
                  <TableCell>
                    {rowActions(
                      c.name,
                      c.value,
                      () =>
                        setEditing({ kind: 'cookies', name: c.name, value: c.value, cookie: c }),
                      () => remove({ kind: 'cookies', cookie: c }),
                    )}
                  </TableCell>
                </TableRow>
              ))}
        </TableBody>
      </Table>
    )
  }

  const entryTable = (area: 'local' | 'session', entries: StorageEntry[]): JSX.Element => {
    const rows = filterEntries(entries, query)
    return (
      <Table aria-label={area === 'local' ? t.local : t.session} className={DENSE_TABLE}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t.key}</TableHead>
            <TableHead>{t.value}</TableHead>
            <TableHead className="text-right">{t.actions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0
            ? emptyRow(3, entries.length)
            : rows.map((e) => (
                <TableRow key={e.key}>
                  <TableCell className="font-mono">{e.key}</TableCell>
                  <TableCell className="max-w-96 font-mono">
                    <ValueCell value={e.value} />
                  </TableCell>
                  <TableCell>
                    {rowActions(
                      e.key,
                      e.value,
                      () => setEditing({ kind: area, name: e.key, value: e.value }),
                      () => remove({ kind: area, key: e.key }),
                    )}
                  </TableCell>
                </TableRow>
              ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <section
      aria-label={t.title}
      className="browser-storage flex h-2/5 min-h-40 flex-none flex-col border-line border-t bg-surface-1"
    >
      <Tabs
        value={kind}
        onValueChange={(value) => setKind(value as StorageKind)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-line border-b bg-surface-2 px-2 py-1">
          <SectionTabsList className="h-7 w-auto border-b-0">
            <SectionTab value="cookies">
              {t.cookies} <span className="text-fg-muted tabular-nums">{counts.cookies}</span>
            </SectionTab>
            <SectionTab value="local">
              {t.local} <span className="text-fg-muted tabular-nums">{counts.local}</span>
            </SectionTab>
            <SectionTab value="session">
              {t.session} <span className="text-fg-muted tabular-nums">{counts.session}</span>
            </SectionTab>
          </SectionTabsList>
          <Input
            className="h-6 w-48 min-w-32 max-w-64 flex-1 text-ui-sm md:text-ui-sm"
            aria-label={t.filter}
            placeholder={t.filterPlaceholder}
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="ml-auto flex items-center gap-1">
            <IconButton icon={ArrowClockwiseIcon} label={t.refresh} onClick={() => void load()} />
            <Button
              variant="outline"
              size="xs"
              disabled={counts[kind] === 0}
              onClick={() => setConfirmClear(true)}
            >
              <TrashIcon data-icon="inline-start" aria-hidden />
              {t.clearAll}
            </Button>
            <IconButton icon={XIcon} label={t.close} onClick={onClose} />
          </div>
        </div>
        {shared ? (
          <p className="flex-none px-3 pt-1 text-fg-muted text-ui-xs">{t.sharedNotice}</p>
        ) : null}
        {kind !== 'cookies' && origin ? (
          <div className="flex-none px-3 pt-1 font-mono text-fg-muted text-ui-xs">
            {fmt(t.origin, { origin })}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto px-1">
          {readError ? (
            <p role="alert" className="px-2 py-3 text-fg-muted text-ui-sm">
              {fmt(t.readFailed, { reason: readError })}
            </p>
          ) : !snapshot ? (
            <p className="px-2 py-3 text-fg-muted text-ui-sm">{t.loading}</p>
          ) : (
            <>
              <TabsContent value="cookies">{cookieTable(snapshot.cookies)}</TabsContent>
              <TabsContent value="local">{entryTable('local', snapshot.local)}</TabsContent>
              <TabsContent value="session">{entryTable('session', snapshot.session)}</TabsContent>
            </>
          )}
        </div>
      </Tabs>
      {status ? (
        <output className="block flex-none border-line border-t px-3 py-1 text-fg-muted text-ui-sm">
          {status}
        </output>
      ) : null}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fmt(t.editTitle, { name: editing?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t.editDescription}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={t.value}
            className="max-h-64 font-mono text-ui-sm md:text-ui-sm"
            value={editing?.value ?? ''}
            spellCheck={false}
            onChange={(e) =>
              setEditing((prev) => (prev ? { ...prev, value: e.target.value } : prev))
            }
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              {t.cancel}
            </Button>
            <Button size="sm" onClick={() => void save()}>
              {t.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{clearCopy[kind].title}</DialogTitle>
            <DialogDescription>{clearCopy[kind].body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)}>
              {t.cancel}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void clearAll()}>
              {t.clearConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
