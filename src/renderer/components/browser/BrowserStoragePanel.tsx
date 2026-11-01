import { ArrowClockwiseIcon, TrashIcon, XIcon } from '@phosphor-icons/react'
import type { StorageKind } from '@shared/browser/browserStorage'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { StorageClearDialog, StorageEditDialog } from './StorageDialogs'
import { CookieTable, EntryTable } from './StorageTables'
import { useBrowserStorage } from './useBrowserStorage'

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
  const locale = useSettingsStore((s) => s.locale)
  const {
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
  } = useBrowserStorage({ paneId, shared, refreshKey, t })

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
              <TabsContent value="cookies">
                <CookieTable
                  cookies={snapshot.cookies}
                  query={query}
                  locale={locale}
                  onCopy={copy}
                  onEdit={setEditing}
                  onRemove={remove}
                />
              </TabsContent>
              <TabsContent value="local">
                <EntryTable
                  area="local"
                  entries={snapshot.local}
                  query={query}
                  onCopy={copy}
                  onEdit={setEditing}
                  onRemove={remove}
                />
              </TabsContent>
              <TabsContent value="session">
                <EntryTable
                  area="session"
                  entries={snapshot.session}
                  query={query}
                  onCopy={copy}
                  onEdit={setEditing}
                  onRemove={remove}
                />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
      {status ? (
        <output className="block flex-none border-line border-t px-3 py-1 text-fg-muted text-ui-sm">
          {status}
        </output>
      ) : null}
      <StorageEditDialog editing={editing} setEditing={setEditing} onSave={() => void save()} />
      <StorageClearDialog
        open={confirmClear}
        setOpen={setConfirmClear}
        title={clearCopy[kind].title}
        body={clearCopy[kind].body}
        onConfirm={() => void clearAll()}
      />
    </section>
  )
}
