import { CheckIcon, CopyIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import type { StorageCookie, StorageEntry, StorageRemoval } from '@shared/browser/browserStorage'
import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fmt, useDict } from '@/lib/app/useDict'
import { cookieRowKey, filterCookies, filterEntries, formatExpiry } from '@/lib/browser/storageRows'
import type { Editing } from './useBrowserStorage'

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
  return on ? <CheckIcon role="img" aria-label={label} className="size-4 text-fg" /> : null
}

function EmptyRow({
  columns,
  total,
  emptyText,
  query,
}: {
  columns: number
  total: number
  emptyText: string
  query: string
}): JSX.Element {
  const t = useDict().browserStorage
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columns} className="py-3 text-center text-fg-muted text-ui-sm">
        {total === 0 ? emptyText : fmt(t.noMatch, { filter: query.trim() })}
      </TableCell>
    </TableRow>
  )
}

function RowActions({
  name,
  value,
  onCopy,
  onEdit,
  onRemove,
}: {
  name: string
  value: string
  onCopy: (name: string, value: string) => void
  onEdit: () => void
  onRemove: () => void
}): JSX.Element {
  const t = useDict().browserStorage
  return (
    <div className="flex justify-end gap-0.5">
      <IconButton
        icon={CopyIcon}
        label={fmt(t.copy, { name })}
        onClick={() => onCopy(name, value)}
      />
      <IconButton icon={PencilSimpleIcon} label={fmt(t.edit, { name })} onClick={onEdit} />
      <IconButton icon={TrashIcon} label={fmt(t.remove, { name })} onClick={onRemove} />
    </div>
  )
}

export function CookieTable({
  cookies,
  query,
  locale,
  onCopy,
  onEdit,
  onRemove,
}: {
  cookies: StorageCookie[]
  query: string
  locale: string
  onCopy: (name: string, value: string) => void
  onEdit: (editing: Editing) => void
  onRemove: (removal: StorageRemoval) => void
}): JSX.Element {
  const t = useDict().browserStorage
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
        {rows.length === 0 ? (
          <EmptyRow columns={9} total={cookies.length} emptyText={t.emptyCookies} query={query} />
        ) : (
          rows.map((c) => (
            <TableRow key={cookieRowKey(c)}>
              <TableCell className="font-mono">{c.name}</TableCell>
              <TableCell className="max-w-64 font-mono">
                <ValueCell value={c.value} />
              </TableCell>
              <TableCell className="font-mono">{c.domain}</TableCell>
              <TableCell className="font-mono">{c.path}</TableCell>
              <TableCell className="tabular-nums">
                {formatExpiry(c.expires, t.sessionExpiry, locale)}
              </TableCell>
              <TableCell>
                <Flag on={c.httpOnly} label={t.yes} />
              </TableCell>
              <TableCell>
                <Flag on={c.secure} label={t.yes} />
              </TableCell>
              <TableCell>{c.sameSite}</TableCell>
              <TableCell>
                <RowActions
                  name={c.name}
                  value={c.value}
                  onCopy={onCopy}
                  onEdit={() =>
                    onEdit({ kind: 'cookies', name: c.name, value: c.value, cookie: c })
                  }
                  onRemove={() => onRemove({ kind: 'cookies', cookie: c })}
                />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

export function EntryTable({
  area,
  entries,
  query,
  onCopy,
  onEdit,
  onRemove,
}: {
  area: 'local' | 'session'
  entries: StorageEntry[]
  query: string
  onCopy: (name: string, value: string) => void
  onEdit: (editing: Editing) => void
  onRemove: (removal: StorageRemoval) => void
}): JSX.Element {
  const t = useDict().browserStorage
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
        {rows.length === 0 ? (
          <EmptyRow
            columns={3}
            total={entries.length}
            emptyText={area === 'local' ? t.emptyLocal : t.emptySession}
            query={query}
          />
        ) : (
          rows.map((e) => (
            <TableRow key={e.key}>
              <TableCell className="font-mono">{e.key}</TableCell>
              <TableCell className="max-w-96 font-mono">
                <ValueCell value={e.value} />
              </TableCell>
              <TableCell>
                <RowActions
                  name={e.key}
                  value={e.value}
                  onCopy={onCopy}
                  onEdit={() => onEdit({ kind: area, name: e.key, value: e.value })}
                  onRemove={() => onRemove({ kind: area, key: e.key })}
                />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
