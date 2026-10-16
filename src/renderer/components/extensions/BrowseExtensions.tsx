import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup, SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
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
  firstSentence,
} from '@/lib/extensions/extensionBrowse'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import type { ExtensionCategory } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { MarketplaceExtension } from '@shared/extensions/marketplace'
import { useMemo, useState } from 'react'
import {
  MarketplaceFailureNote,
  MarketplacesGroup,
  UninstallExtensionButton,
  marketplaceName,
  useMarketplaceList,
} from './MarketplaceSection'
import { extensionIcon } from './extensionIcons'

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
  onInstalled,
}: {
  entry: BrowseEntry
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
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void runInstall()}>
          {d.marketplace.install}
        </Button>
      )
    case 'update':
      return (
        <Button size="sm" disabled={busy} onClick={() => void runInstall()}>
          {d.extensionsBrowse.updateShort}
        </Button>
      )
    case 'installed':
      return <UninstallExtensionButton extId={ext.id} name={ext.name} />
    case 'replace':
    case 'conflict':
      return null
  }
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
  const replace = async (): Promise<void> => {
    if (await install(marketplace.id, ext.id)) onInstalled(ext.id)
  }
  const description = withProductName(ext.description)
  return (
    <>
      {description ? <p className="mb-2 text-fg text-ui-sm">{description}</p> : null}
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
      <SettingsSubgroup title={d.extensions.groupDetails} />
      <ControlRow label={d.extensions.version}>
        <Value>
          {ext.state === 'update' && ext.installedVersion
            ? fmt(d.extensionsBrowse.versionChange, {
                installed: ext.installedVersion,
                offered: ext.version,
              })
            : ext.version}
        </Value>
      </ControlRow>
      <ControlRow label={d.extensions.sourceLabel}>
        <Value>
          {fmt(d.extensions.sourceMarketplace, { name: marketplaceName(d, marketplace) })}
        </Value>
      </ControlRow>
      <ControlRow label={d.extensions.categoryLabel}>
        <Value>{d.extensions.categories[ext.category]}</Value>
      </ControlRow>
      <div className="mt-3" />
      <SettingsSubgroup
        title={d.extensions.permissions}
        desc={ext.runsProcess ? d.marketplace.runsProcess : d.marketplace.dataOnly}
      />
      {ext.capabilities.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{d.extensions.noPermissions}</p>
      ) : (
        ext.capabilities.map((cap) => (
          <ControlRow key={cap} label={cap} desc={d.extensions.capabilityAllows[cap] ?? cap}>
            <Badge variant="secondary" className="text-ui-xs">
              {d.extensions.requested}
            </Badge>
          </ControlRow>
        ))
      )}
      {ext.agentSkills.length > 0 || ext.agentHooks.length > 0 ? (
        <>
          <div className="mt-3" />
          <SettingsSubgroup title={d.extensions.agentPluginTitle} />
          {ext.agentSkills.length > 0 ? (
            <p className="py-1.5 text-fg-muted text-ui-sm">
              {fmt(d.extensions.agentSkillsList, { list: ext.agentSkills.join(', ') })}
            </p>
          ) : null}
          {ext.agentHooks.map((hook) => (
            <p key={`${hook.event}:${hook.command}`} className="py-1.5 text-fg-muted text-ui-sm">
              {fmt(d.extensionsBrowse.agentHook, { event: hook.event, command: hook.command })}
            </p>
          ))}
        </>
      ) : null}
      {ext.state === 'update' ? (
        <ControlRow label={d.marketplace.uninstall}>
          <UninstallExtensionButton extId={ext.id} name={ext.name} />
        </ControlRow>
      ) : null}
    </>
  )
}

function Value({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="text-fg-muted text-ui-sm tabular-nums">{children}</span>
}

function ResultRow({
  entry,
  onInstalled,
}: {
  entry: BrowseEntry
  onInstalled: (extId: string) => void
}): JSX.Element {
  const d = useDict()
  const { ext, marketplace } = entry
  const Icon = extensionIcon(ext.icon)
  return (
    <SettingsListRow
      aria-label={ext.name}
      lead={<Icon aria-hidden className="size-4" />}
      title={ext.name}
      meta={<StateChip ext={ext} />}
      detail={
        <span className="block truncate">
          {[firstSentence(withProductName(ext.description)), marketplaceName(d, marketplace)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      }
      actions={<EntryAction entry={entry} onInstalled={onInstalled} />}
      expandLabel={fmt(d.extensions.detailsOf, { name: ext.name })}
      expanded={<EntryDetails entry={entry} onInstalled={onInstalled} />}
    />
  )
}

function splitProblem(problem: string): { id: string; reason: string } {
  const at = problem.indexOf(': ')
  return at < 0
    ? { id: problem, reason: '' }
    : { id: problem.slice(0, at), reason: problem.slice(at + 2) }
}

function NotCompatibleRow({ problems }: { problems: string[] }): JSX.Element {
  const d = useDict()
  return (
    <SettingsListRow
      title={fmt(d.extensionsBrowse.notCompatible, { count: problems.length })}
      detail={d.extensionsBrowse.notCompatibleDesc}
      expandLabel={d.extensionsBrowse.notCompatibleDetails}
      expanded={problems.map((problem) => {
        const { id, reason } = splitProblem(problem)
        return <ControlRow key={problem} label={id} desc={reason || undefined} />
      })}
    />
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
  const [installedId, setInstalledId] = useState<string | null>(null)
  const entries = useMemo(() => browseEntries(marketplaces), [marketplaces])
  const categories = useMemo(() => browseCategories(entries), [entries])
  const problems = marketplaces.flatMap((m) => m.problems)
  const results = filterBrowseEntries(
    entries,
    { text, filter, category: category === ALL_CATEGORIES ? null : category },
    (c) => d.extensions.categories[c],
  )
  const empty =
    entries.length === 0
      ? marketplaces.some((m) => !m.downloaded)
        ? d.extensionsBrowse.notDownloaded
        : d.extensionsBrowse.noMarketplaces
      : d.extensionsBrowse.noResults

  return (
    <SettingsPage title={d.extensionsBrowse.title} desc={d.extensionsBrowse.desc}>
      <MarketplaceFailureNote />
      {installedId ? <InstalledNote extId={installedId} /> : null}
      <SettingsGroup title={d.extensionsBrowse.groupExtensions}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
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
        <SettingsList label={d.extensionsBrowse.results} empty={empty}>
          {results.map((entry) => (
            <ResultRow key={entry.key} entry={entry} onInstalled={setInstalledId} />
          ))}
          {problems.length > 0 ? <NotCompatibleRow problems={problems} /> : null}
        </SettingsList>
      </SettingsGroup>
      <MarketplacesGroup />
    </SettingsPage>
  )
}
