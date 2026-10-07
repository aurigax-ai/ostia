import { cn } from '@/lib/utils'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { ExtensionCategory } from '@shared/extensions'
import type { MarketplaceExtension } from '@shared/marketplace'
import { useMemo, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict, withProductName } from '../i18n/useDict'
import {
  BROWSE_FILTERS,
  type BrowseChip,
  type BrowseEntry,
  type BrowseFilter,
  browseCategories,
  browseChip,
  browseEntries,
  filterBrowseEntries,
  firstSentence,
} from '../lib/extensionBrowse'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useMarketplaceStore } from '../stores/marketplaceStore'
import { useUIStore } from '../stores/uiStore'
import {
  MarketplaceFailureNote,
  MarketplacesPanel,
  UninstallExtensionButton,
  useMarketplaceList,
} from './MarketplaceSection'
import { SectionHead, SelectField, WarningNote } from './SettingsPanel'
import { TextLink } from './TextLink'
import { extensionIcon } from './extensionIcons'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ButtonGroup } from './ui/button-group'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { Separator } from './ui/separator'

const ALL_CATEGORIES = 'all'

function filterLabel(d: Dict, filter: BrowseFilter): string {
  switch (filter) {
    case 'all':
      return d.extensionsBrowse.filterAll
    case 'installed':
      return d.extensionsBrowse.filterInstalled
    case 'not-installed':
      return d.extensionsBrowse.filterNotInstalled
    case 'updates':
      return d.extensionsBrowse.filterUpdates
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
  }
}

function StateChip({ ext }: { ext: MarketplaceExtension }): JSX.Element | null {
  const d = useDict()
  const chip = browseChip(ext.state)
  if (!chip) return null
  return (
    <Badge
      variant={chip === 'installed' ? 'outline' : 'secondary'}
      className={cn('text-ui-xs', chip === 'problem' && 'text-warn-fg')}
    >
      {chipLabel(d, chip)}
    </Badge>
  )
}

function openInExtensions(extId: string): void {
  useUIStore.getState().openSettings('extensions', { extension: extId })
}

function EntryAction({
  entry,
  size,
  onInstalled,
}: {
  entry: BrowseEntry
  size: 'xs' | 'sm'
  onInstalled: (extId: string) => void
}): JSX.Element | null {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const install = useMarketplaceStore((s) => s.install)
  const { ext, marketplace } = entry
  const runInstall = async (): Promise<void> => {
    if (await install(marketplace.id, ext.id)) onInstalled(ext.id)
  }
  switch (ext.state) {
    case 'available':
      return (
        <Button variant="outline" size={size} disabled={busy} onClick={() => void runInstall()}>
          {d.marketplace.install}
        </Button>
      )
    case 'update':
      return (
        <Button size={size} disabled={busy} onClick={() => void runInstall()}>
          {size === 'xs'
            ? d.extensionsBrowse.updateShort
            : fmt(d.marketplace.update, { version: ext.version })}
        </Button>
      )
    case 'installed':
      return <UninstallExtensionButton extId={ext.id} name={ext.name} size={size} />
    case 'replace':
    case 'conflict':
      return null
  }
}

function ResultRow({
  entry,
  selected,
  onSelect,
  onInstalled,
}: {
  entry: BrowseEntry
  selected: boolean
  onSelect: () => void
  onInstalled: (extId: string) => void
}): JSX.Element {
  const { ext, marketplace } = entry
  const Icon = extensionIcon(ext.icon)
  return (
    <li
      aria-label={ext.name}
      data-selected={selected || undefined}
      className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-surface-2 data-[selected]:bg-surface-2"
    >
      <button
        type="button"
        aria-label={ext.name}
        aria-current={selected || undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-fg text-ui-sm">{ext.name}</span>
            <StateChip ext={ext} />
          </span>
          <span className="block truncate text-fg-muted text-ui-xs">
            {[firstSentence(withProductName(ext.description)), marketplace.name]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </button>
      <div className="shrink-0">
        <EntryAction entry={entry} size="xs" onInstalled={onInstalled} />
      </div>
    </li>
  )
}

function EntryDetails({
  entry,
  onInstalled,
}: {
  entry: BrowseEntry
  onInstalled: (extId: string) => void
}): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const install = useMarketplaceStore((s) => s.install)
  const { ext, marketplace } = entry
  const Icon = extensionIcon(ext.icon)
  const replace = async (): Promise<void> => {
    if (await install(marketplace.id, ext.id)) onInstalled(ext.id)
  }
  return (
    <section
      aria-label={d.extensionsBrowse.details}
      className="flex min-w-0 flex-col gap-3 rounded-sm border border-line p-3"
    >
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-fg text-ui-base">{ext.name}</h3>
            <StateChip ext={ext} />
          </div>
          <p className="text-fg-muted text-ui-xs tabular-nums">
            {ext.state === 'update' && ext.installedVersion
              ? fmt(d.extensionsBrowse.versionChange, {
                  installed: ext.installedVersion,
                  offered: ext.version,
                })
              : fmt(d.extensionsBrowse.version, { version: ext.version })}
            {' · '}
            {fmt(d.extensionsBrowse.marketplace, { name: marketplace.name })}
            {' · '}
            {d.extensions.categories[ext.category]}
          </p>
        </div>
      </div>
      {ext.state === 'conflict' ? (
        <WarningNote
          actions={
            <TextLink size="xs" onClick={() => openInExtensions(ext.id)}>
              {d.extensionsBrowse.showInstalled}
            </TextLink>
          }
        >
          {d.marketplace.conflict}
        </WarningNote>
      ) : null}
      {ext.state === 'replace' ? (
        <WarningNote
          actions={
            <TextLink size="xs" disabled={busy} onClick={() => void replace()}>
              {d.marketplace.replace}
            </TextLink>
          }
        >
          {d.marketplace.orphaned}
        </WarningNote>
      ) : null}
      {ext.description ? (
        <p className="text-fg text-ui-sm">{withProductName(ext.description)}</p>
      ) : null}
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-fg text-ui-sm">{d.extensionsBrowse.permissions}</h4>
        <p className="text-fg-muted text-ui-xs">
          {ext.runsProcess ? d.marketplace.runsProcess : d.marketplace.dataOnly}
        </p>
        {ext.capabilities.length === 0 ? (
          <p className="text-fg-muted text-ui-xs">{d.extensions.noPermissions}</p>
        ) : (
          <ul aria-label={d.extensionsBrowse.permissions} className="flex flex-col gap-1">
            {ext.capabilities.map((cap) => (
              <li key={cap} className="flex items-baseline gap-2 text-ui-xs">
                <Badge variant="outline" className="shrink-0 font-mono text-ui-xs">
                  {cap}
                </Badge>
                <span className="text-fg-muted">{d.extensions.capabilityAllows[cap] ?? cap}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {ext.agentSkills.length > 0 || ext.agentHooks.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <h4 className="font-medium text-fg text-ui-sm">{d.extensions.agentPluginTitle}</h4>
          {ext.agentSkills.length > 0 ? (
            <p className="text-fg-muted text-ui-xs">
              {fmt(d.extensions.agentSkillsList, { list: ext.agentSkills.join(', ') })}
            </p>
          ) : null}
          {ext.agentHooks.map((hook) => (
            <p key={`${hook.event}:${hook.command}`} className="text-fg-muted text-ui-xs">
              {fmt(d.extensionsBrowse.agentHook, { event: hook.event, command: hook.command })}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <EntryAction entry={entry} size="sm" onInstalled={onInstalled} />
        {ext.state === 'update' ? (
          <UninstallExtensionButton extId={ext.id} name={ext.name} />
        ) : null}
      </div>
    </section>
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
    <output className="mb-2 flex flex-wrap items-center gap-x-2 text-fg text-ui-sm">
      {fmt(d.extensionsBrowse.waitsForApproval, { name })}
      <TextLink size="xs" className="h-5 px-0 text-ui-sm" onClick={() => openInExtensions(extId)}>
        {d.extensionsBrowse.openInExtensions}
      </TextLink>
    </output>
  )
}

export function BrowseExtensions(): JSX.Element {
  const d = useDict()
  const marketplaces = useMarketplaceList()
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<BrowseFilter>('all')
  const [category, setCategory] = useState<ExtensionCategory | typeof ALL_CATEGORIES>(
    ALL_CATEGORIES,
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [installedId, setInstalledId] = useState<string | null>(null)
  const entries = useMemo(() => browseEntries(marketplaces), [marketplaces])
  const categories = useMemo(() => browseCategories(entries), [entries])
  const results = filterBrowseEntries(
    entries,
    { text, filter, category: category === ALL_CATEGORIES ? null : category },
    (c) => d.extensions.categories[c],
  )
  const selected = results.find((e) => e.key === selectedKey) ?? results[0] ?? null

  return (
    <section aria-label={d.extensionsBrowse.title}>
      <SectionHead title={d.extensionsBrowse.title} desc={d.extensionsBrowse.desc} />
      <MarketplaceFailureNote />
      {installedId ? <InstalledNote extId={installedId} /> : null}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <InputGroup className="h-7 min-w-48 flex-1">
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={d.extensionsBrowse.searchPlaceholder}
            aria-label={d.extensionsBrowse.search}
          />
        </InputGroup>
        <ButtonGroup aria-label={d.extensionsBrowse.filters}>
          {BROWSE_FILTERS.map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {filterLabel(d, f)}
            </Button>
          ))}
        </ButtonGroup>
        <SelectField
          value={category}
          onChange={setCategory}
          label={d.extensionsBrowse.category}
          width="w-fit min-w-36"
          options={[
            { value: ALL_CATEGORIES, label: d.extensionsBrowse.allCategories },
            ...categories.map((c) => ({ value: c, label: d.extensions.categories[c] })),
          ]}
        />
      </div>
      {entries.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.extensionsBrowse.noMarketplaces}</p>
      ) : results.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.extensionsBrowse.noResults}</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start gap-4">
          <ul aria-label={d.extensionsBrowse.results} className="flex flex-col gap-0.5">
            {results.map((entry) => (
              <ResultRow
                key={entry.key}
                entry={entry}
                selected={entry.key === selected?.key}
                onSelect={() => setSelectedKey(entry.key)}
                onInstalled={setInstalledId}
              />
            ))}
          </ul>
          {selected ? <EntryDetails entry={selected} onInstalled={setInstalledId} /> : null}
        </div>
      )}
      <Separator className="my-4" />
      <MarketplacesPanel />
    </section>
  )
}
