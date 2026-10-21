import type { ExtensionCategory } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import {
  MARKETPLACE_CODE_SHAPE,
  type MarketplaceExtension,
  type MarketplaceFound,
  type MarketplaceInfo,
} from '@shared/extensions/marketplace'
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Notice } from '@/components/common/Notice'
import { Segmented } from '@/components/common/Segmented'
import { TextLink } from '@/components/common/TextLink'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fmt, useDict, withProductName } from '@/lib/app/useDict'
import {
  BROWSE_FILTERS,
  type BrowseChip,
  type BrowseEntry,
  type BrowseFilter,
  browseCategories,
  browseChip,
  browseEntries,
  filterBrowseEntries,
} from '@/lib/extensions/extensionBrowse'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import { ExtensionTile } from './ExtensionTile'
import {
  MarketplaceFailureNote,
  marketplaceName,
  UninstallExtensionButton,
  useMarketplaceList,
} from './MarketplaceSection'

const ALL_CATEGORIES = 'all'

function filterLabel(d: Dict, filter: BrowseFilter, updates: number): string {
  switch (filter) {
    case 'all':
      return d.extensionsBrowse.filterAll
    case 'installed':
      return d.extensionsBrowse.filterInstalled
    case 'updates':
      return updates > 0
        ? fmt(d.extensionsBrowse.filterUpdatesCount, { count: updates })
        : d.extensionsBrowse.filterUpdates
  }
}

function chipLabel(d: Dict, chip: BrowseChip): string {
  switch (chip) {
    case 'installed':
      return d.extensionsBrowse.stateInstalled
    case 'update':
      return d.extensionsBrowse.stateUpdate
    case 'problem':
      return d.extensionsBrowse.stateProblem
    case 'incompatible':
      return d.extensionsBrowse.stateIncompatible
  }
}

interface Shown {
  entry: BrowseEntry
  unlisted: boolean
}

function useUnlistedMatch(
  text: string,
  marketplaces: readonly MarketplaceInfo[],
): MarketplaceFound | null {
  const code = text.trim()
  const [found, setFound] = useState<{ code: string; result: MarketplaceFound } | null>(null)
  useEffect(() => {
    void marketplaces
    if (!MARKETPLACE_CODE_SHAPE.test(code)) return
    let live = true
    void window.ostia.marketplace.findCode(code).then((result) => {
      if (live) setFound({ code, result })
    })
    return () => {
      live = false
    }
  }, [code, marketplaces])
  return found?.code === code ? found.result : null
}

function Card({
  shown,
  selected,
  onPick,
}: {
  shown: Shown
  selected: boolean
  onPick: () => void
}): JSX.Element {
  const d = useDict()
  const { ext } = shown.entry
  const chip = shown.unlisted ? null : browseChip(ext.state)
  const label = shown.unlisted ? d.extensionsBrowse.unlisted : chip ? chipLabel(d, chip) : null
  const onKey = (e: KeyboardEvent<HTMLLIElement>): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick()
    }
  }
  return (
    <SettingsListRow
      aria-label={ext.name}
      aria-current={selected || undefined}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={onKey}
      className={cn(
        'cursor-pointer rounded-md px-2 hover:bg-surface-2/60',
        selected && 'bg-surface-2',
      )}
      lead={<ExtensionTile icon={ext.icon} />}
      title={ext.name}
      meta={
        label ? (
          <Badge
            variant={chip === 'installed' || shown.unlisted ? 'outline' : 'secondary'}
            className={cn('text-ui-xs', chip === 'problem' && 'text-warn-fg')}
          >
            {label}
          </Badge>
        ) : null
      }
      detail={<span className="line-clamp-2">{withProductName(ext.description)}</span>}
    />
  )
}

function Permissions({ ext }: { ext: MarketplaceExtension }): JSX.Element {
  const d = useDict()
  return (
    <section>
      <h3 className="mb-1 font-medium text-fg text-ui-base">{d.extensionsBrowse.asksTo}</h3>
      {ext.capabilities.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.extensions.noPermissions}</p>
      ) : (
        <ul className="flex flex-col">
          {ext.capabilities.map((cap) => (
            <SettingsListRow key={cap} title={d.extensions.capabilityAllows[cap] ?? cap} />
          ))}
        </ul>
      )}
      {ext.runsProcess ? (
        <Notice>{d.marketplace.runsProcess}</Notice>
      ) : (
        <p className="mt-1 text-fg-muted text-ui-sm">{d.marketplace.dataOnly}</p>
      )}
    </section>
  )
}

function AgentPlugin({ ext }: { ext: MarketplaceExtension }): JSX.Element | null {
  const d = useDict()
  if (ext.agentSkills.length === 0 && ext.agentHooks.length === 0) return null
  return (
    <section>
      <h3 className="mb-1 font-medium text-fg text-ui-base">{d.extensions.agentPluginTitle}</h3>
      {ext.agentSkills.length > 0 ? (
        <p className="text-fg-muted text-ui-sm">
          {fmt(d.extensions.agentSkillsList, { list: ext.agentSkills.join(', ') })}
        </p>
      ) : null}
      {ext.agentHooks.map((hook) => (
        <p key={`${hook.event}:${hook.command}`} className="text-fg-muted text-ui-sm">
          {fmt(d.extensionsBrowse.agentHook, { event: hook.event, command: hook.command })}
        </p>
      ))}
    </section>
  )
}

function openInExtensions(extId: string): void {
  const ui = useUIStore.getState()
  ui.closeBrowseExtensions()
  ui.openSettings('extensions', { extension: extId })
}

function PageAction({
  marketplace,
  ext,
  code,
  onInstalled,
}: {
  marketplace: MarketplaceInfo
  ext: MarketplaceExtension
  code: string | null
  onInstalled: (extId: string) => void
}): JSX.Element | null {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const install = useMarketplaceStore((s) => s.install)
  const installCode = useMarketplaceStore((s) => s.installCode)
  const run = async (): Promise<void> => {
    const ok = code
      ? await installCode(marketplace.id, code)
      : await install(marketplace.id, ext.id)
    if (ok) onInstalled(ext.id)
  }
  switch (ext.state) {
    case 'available':
      return (
        <Button size="sm" disabled={busy} onClick={() => void run()}>
          {d.marketplace.install}
        </Button>
      )
    case 'update':
      return (
        <>
          <UninstallExtensionButton extId={ext.id} name={ext.name} />
          <Button size="sm" disabled={busy} onClick={() => void run()}>
            {fmt(d.extensions.updateTo, { version: ext.version })}
          </Button>
        </>
      )
    case 'installed':
      return <UninstallExtensionButton extId={ext.id} name={ext.name} />
    case 'replace':
    case 'conflict':
    case 'incompatible':
      return null
  }
}

function ExtensionPage({
  shown,
  code,
  onInstalled,
}: {
  shown: Shown
  code: string | null
  onInstalled: (extId: string) => void
}): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const install = useMarketplaceStore((s) => s.install)
  const { ext, marketplace } = shown.entry
  const source = fmt(d.extensions.sourceMarketplace, { name: marketplaceName(d, marketplace) })
  const replace = async (): Promise<void> => {
    if (await install(marketplace.id, ext.id)) onInstalled(ext.id)
  }
  return (
    <div data-testid="extension-page" className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
      <div className="flex items-start gap-3 pr-8">
        <ExtensionTile icon={ext.icon} size="lg" />
        <div className="min-w-0 grow">
          <h2 className="font-semibold text-fg text-ui-lg">{ext.name}</h2>
          <p className="text-fg-muted text-ui-sm">
            {fmt(d.extensionsBrowse.pageMeta, {
              category: d.extensions.categories[ext.category],
              version:
                ext.state === 'update' && ext.installedVersion
                  ? fmt(d.extensionsBrowse.versionChange, {
                      installed: ext.installedVersion,
                      offered: ext.version,
                    })
                  : ext.version,
              source: shown.unlisted
                ? fmt(d.extensionsBrowse.sourceUnlisted, { name: source })
                : source,
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PageAction marketplace={marketplace} ext={ext} code={code} onInstalled={onInstalled} />
        </div>
      </div>
      {ext.state === 'conflict' ? (
        <Notice
          actions={
            <TextLink size="xs" onClick={() => openInExtensions(ext.id)}>
              {d.extensionsBrowse.showInstalled}
            </TextLink>
          }
        >
          {d.marketplace.conflict}
        </Notice>
      ) : null}
      {ext.state === 'incompatible' && ext.needsApi ? (
        <Notice>{fmt(d.marketplace.needsApp, { api: ext.needsApi })}</Notice>
      ) : null}
      {ext.installedRevoked ? <Notice>{d.marketplace.revoked}</Notice> : null}
      {ext.state === 'replace' ? (
        <Notice
          actions={
            <TextLink size="xs" disabled={busy} onClick={() => void replace()}>
              {d.marketplace.replace}
            </TextLink>
          }
        >
          {d.marketplace.orphaned}
        </Notice>
      ) : null}
      <p className="text-fg text-ui-base">{withProductName(ext.description)}</p>
      <Permissions ext={ext} />
      <AgentPlugin ext={ext} />
    </div>
  )
}

function splitProblem(problem: string): { id: string; reason: string } {
  const at = problem.indexOf(': ')
  return at < 0
    ? { id: problem, reason: '' }
    : { id: problem.slice(0, at), reason: problem.slice(at + 2) }
}

function ProblemsPage({ problems }: { problems: string[] }): JSX.Element {
  const d = useDict()
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
      <div className="pr-8">
        <h2 className="font-semibold text-fg text-ui-lg">
          {d.extensionsBrowse.notCompatibleDetails}
        </h2>
        <p className="text-fg-muted text-ui-sm">{d.extensionsBrowse.notCompatibleDesc}</p>
      </div>
      <ul className="flex flex-col">
        {problems.map((problem) => {
          const { id, reason } = splitProblem(problem)
          return <SettingsListRow key={problem} title={id} detail={reason || undefined} />
        })}
      </ul>
    </div>
  )
}

function InstalledNote({ extId }: { extId: string }): JSX.Element | null {
  const d = useDict()
  const ext = useExtensionsStore((s) => s.list.find((e) => e.id === extId))
  const offered = useMarketplaceStore((s) =>
    s.state.marketplaces.flatMap((m) => m.extensions).find((e) => e.id === extId),
  )
  if (ext && ext.status !== 'pending-approval') return null
  const name = ext?.name ?? offered?.name ?? extId
  return (
    <output className="flex flex-wrap items-center gap-x-2 text-fg text-ui-sm">
      {fmt(d.extensionsBrowse.waitsForApproval, { name })}
      <TextLink size="xs" className="h-5 px-0 text-ui-sm" onClick={() => openInExtensions(extId)}>
        {d.extensionsBrowse.openInExtensions}
      </TextLink>
    </output>
  )
}

export function BrowseExtensionsDialog(): JSX.Element {
  const d = useDict()
  const close = useUIStore((s) => s.closeBrowseExtensions)
  const marketplaces = useMarketplaceList()
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<BrowseFilter>('all')
  const [category, setCategory] = useState<ExtensionCategory | typeof ALL_CATEGORIES>(
    ALL_CATEGORIES,
  )
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const [installedId, setInstalledId] = useState<string | null>(null)
  const entries = useMemo(() => browseEntries(marketplaces), [marketplaces])
  const match = useUnlistedMatch(text, marketplaces)
  const categories = useMemo(() => browseCategories(entries), [entries])
  const updates = entries.filter(({ ext }) => ext.state === 'update').length
  const problems = marketplaces.flatMap((m) => m.problems)
  const code = text.trim()

  const unlisted: Shown[] = useMemo(() => {
    if (!match?.ok) return []
    const owner = marketplaces.find((m) => m.id === match.marketplaceId)
    if (!owner) return []
    const listed = entries.find(
      (e) => e.marketplace.id === match.marketplaceId && e.ext.id === match.extension.id,
    )
    return [
      {
        unlisted: true,
        entry: listed ?? {
          key: `${owner.id}/${match.extension.id}`,
          marketplace: owner,
          ext: match.extension,
        },
      },
    ]
  }, [match, marketplaces, entries])

  const results: Shown[] =
    unlisted.length > 0
      ? unlisted
      : filterBrowseEntries(
          entries,
          { text, filter, category: category === ALL_CATEGORIES ? null : category },
          (c) => d.extensions.categories[c],
        ).map((entry) => ({ entry, unlisted: false }))
  const picked = results.find((r) => r.entry.key === pickedKey) ?? results[0] ?? null
  const empty =
    entries.length === 0
      ? marketplaces.some((m) => !m.downloaded)
        ? d.extensionsBrowse.notDownloaded
        : d.extensionsBrowse.noMarketplaces
      : MARKETPLACE_CODE_SHAPE.test(code) && match && !match.ok
        ? d.marketplace.errors[match.error]
        : d.extensionsBrowse.noResults

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="h-[min(640px,calc(100vh-4rem))] grid-cols-[340px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">{d.extensionsBrowse.title}</DialogTitle>
        <div className="flex min-h-0 flex-col gap-2 bg-surface-1 p-3">
          <InputGroup className="h-8">
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setShowProblems(false)
              }}
              placeholder={d.extensionsBrowse.searchPlaceholder}
              aria-label={d.extensionsBrowse.search}
              className={cn(MARKETPLACE_CODE_SHAPE.test(code) && 'font-mono')}
            />
          </InputGroup>
          <div className="flex items-center gap-2">
            <Segmented
              label={d.extensionsBrowse.filters}
              value={filter}
              options={BROWSE_FILTERS.map((f) => ({ value: f, label: filterLabel(d, f, updates) }))}
              onChange={setFilter}
            />
            <SelectField
              value={category}
              onChange={setCategory}
              label={d.extensionsBrowse.category}
              width="w-full min-w-0"
              options={[
                { value: ALL_CATEGORIES, label: d.extensionsBrowse.allCategories },
                ...categories.map((c) => ({ value: c, label: d.extensions.categories[c] })),
              ]}
            />
          </div>
          {unlisted.length > 0 && match?.ok ? (
            <p className="text-fg-muted text-ui-sm">
              {fmt(d.extensionsBrowse.codeFound, {
                name: marketplaceName(
                  d,
                  marketplaces.find((m) => m.id === match.marketplaceId) ?? marketplaces[0],
                ),
              })}
            </p>
          ) : null}
          <ScrollArea className="-mx-1 min-h-0 flex-1">
            <div className="px-1">
              <SettingsList label={d.extensionsBrowse.results} empty={empty}>
                {results.map((shown) => (
                  <Card
                    key={shown.entry.key}
                    shown={shown}
                    selected={!showProblems && shown.entry.key === picked?.entry.key}
                    onPick={() => {
                      setPickedKey(shown.entry.key)
                      setShowProblems(false)
                    }}
                  />
                ))}
              </SettingsList>
            </div>
          </ScrollArea>
          {problems.length > 0 ? (
            <TextLink
              size="xs"
              className="h-auto justify-start p-0 text-ui-sm"
              aria-pressed={showProblems}
              onClick={() => setShowProblems((was) => !was)}
            >
              {fmt(d.extensionsBrowse.notCompatible, { count: problems.length })}
            </TextLink>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-col">
          <MarketplaceFailureNote />
          {installedId ? (
            <div className="px-5 pt-4 pr-12">
              <InstalledNote extId={installedId} />
            </div>
          ) : null}
          {showProblems ? (
            <ProblemsPage problems={problems} />
          ) : picked ? (
            <ExtensionPage
              key={picked.entry.key}
              shown={picked}
              code={picked.unlisted ? code : null}
              onInstalled={setInstalledId}
            />
          ) : (
            <EmptyState variant="surface" size="sm" desc={empty} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
