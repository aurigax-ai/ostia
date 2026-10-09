import { isAssistExtension } from '@/components/assist/AssistantSection'
import { TextLink } from '@/components/common/TextLink'
import { WarningNote } from '@/components/settings/SettingsPanel'
import { SearchGroup } from '@/components/settings/SettingsSearch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict, withProductName } from '@/i18n/useDict'
import { useReducedMotion } from '@/lib/app/motion'
import { extensionAnchorId } from '@/lib/app/settingsNav'
import { entryTitle } from '@/lib/extensions/extensionSettingText'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { Capability } from '@shared/capabilities'
import type { ExtensionInfo } from '@shared/extensions'
import { useEffect, useState } from 'react'
import { ExtensionAgentPlugin } from './ExtensionAgentPlugin'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { UninstallExtensionButton, useMarketplaceList } from './MarketplaceSection'
import { extensionIcon } from './extensionIcons'

export interface ExtensionAnchor {
  id: string
  nonce: number
}

const ANCHOR_HIGHLIGHT_MS = 2000

type InstalledChip = 'enabled' | 'disabled' | 'needs-approval' | 'problem'

function installedChip(ext: ExtensionInfo): InstalledChip {
  if (ext.status === 'pending-approval') return 'needs-approval'
  if (ext.status === 'crashed' || ext.unapproved.length > 0) return 'problem'
  return ext.enabled ? 'enabled' : 'disabled'
}

function chipLabel(d: Dict, chip: InstalledChip): string {
  switch (chip) {
    case 'enabled':
      return d.extensions.stateEnabled
    case 'disabled':
      return d.extensions.stateDisabled
    case 'needs-approval':
      return d.extensions.stateNeedsApproval
    case 'problem':
      return d.extensions.stateProblem
  }
}

function StateChip({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const chip = installedChip(ext)
  return (
    <Badge
      variant={chip === 'enabled' || chip === 'disabled' ? 'outline' : 'secondary'}
      className={cn(
        'text-ui-xs',
        chip === 'disabled' && 'text-fg-muted',
        chip === 'problem' && 'text-warn-fg',
      )}
    >
      {chipLabel(d, chip)}
    </Badge>
  )
}

function extensionStatusLabel(d: Dict, ext: ExtensionInfo): string {
  switch (ext.status) {
    case 'running':
      return d.extensions.statusRunning
    case 'starting':
      return d.extensions.statusStarting
    case 'crashed':
      return d.extensions.statusCrashed
    case 'disabled':
      return d.extensions.statusDisabled
    case 'pending-approval':
      return d.extensions.statusPending
    default:
      return d.extensions.statusIdle
  }
}

function useSourceLabel(ext: ExtensionInfo): string {
  const d = useDict()
  const marketplaces = useMarketplaceStore((s) => s.state.marketplaces)
  const fromMarketplace = useMarketplaceStore((s) => s.state.installed.includes(ext.id))
  if (ext.builtin) return d.extensions.sourceBuiltin
  const owner = marketplaces.find((m) => m.installs.includes(ext.id))
  if (owner) return fmt(d.extensions.sourceMarketplace, { name: owner.name })
  return fromMarketplace ? d.extensions.sourceOrphaned : d.extensions.sourceManual
}

function CapabilityList({
  label,
  caps,
}: {
  label: string
  caps: readonly Capability[]
}): JSX.Element {
  const d = useDict()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-fg-muted text-ui-xs">{label}</span>
      {caps.length === 0 ? (
        <p className="text-fg-muted text-ui-xs">{d.extensions.noPermissions}</p>
      ) : (
        <ul aria-label={label} className="flex flex-col gap-1">
          {caps.map((cap) => (
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
  )
}

function ExtensionSettingsArea({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  if (ext.settingsPage) {
    return (
      <TextLink
        size="xs"
        className="h-5 self-start px-0 text-ui-sm"
        onClick={() => useUIStore.getState().openSettings('extensions', { extension: ext.id })}
      >
        {d.extensions.openSettingsPage}
      </TextLink>
    )
  }
  if (isAssistExtension(ext)) {
    return ext.enabled ? (
      <TextLink
        size="xs"
        className="h-5 self-start px-0 text-ui-sm"
        onClick={() => useUIStore.getState().openSettings('assistant')}
      >
        {d.assistantSettings.configure}
      </TextLink>
    ) : null
  }
  if (ext.settings.length === 0 && ext.secrets.length === 0) {
    return <p className="text-fg-muted text-ui-sm">{d.extensions.noSettings}</p>
  }
  return <ExtensionSettingsForm ext={ext} bare />
}

function ExtensionDetails({
  ext,
  flash,
}: {
  ext: ExtensionInfo
  flash: ExtensionAnchor | null
}): JSX.Element {
  const d = useDict()
  const review = useExtensionsStore((s) => s.review)
  const reducedMotion = useReducedMotion()
  const source = useSourceLabel(ext)
  const Icon = extensionIcon(ext.panel?.icon ?? ext.settingsPage?.icon)
  const needsReview =
    !ext.builtin && (ext.status === 'pending-approval' || ext.unapproved.length > 0)
  return (
    <section
      id={extensionAnchorId(ext.id)}
      tabIndex={-1}
      aria-label={ext.name}
      className="relative flex min-w-0 scroll-mt-3 flex-col gap-3 rounded-sm border border-line p-3 outline-none"
    >
      {flash?.id === ext.id ? (
        <span
          key={flash.nonce}
          aria-hidden
          data-testid="extension-anchor-highlight"
          className={cn(
            'settings-anchor-highlight pointer-events-none absolute inset-0 rounded-sm',
            reducedMotion && 'settings-anchor-highlight-static',
          )}
        />
      ) : null}
      <div className="flex items-start gap-2.5">
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-fg text-ui-base">{ext.name}</h3>
            <StateChip ext={ext} />
          </div>
          <p className="text-fg-muted text-ui-xs tabular-nums">
            {ext.version} · {source} · {d.extensions.categories[ext.category]}
          </p>
        </div>
      </div>
      {ext.description ? (
        <p className="text-fg text-ui-sm">{withProductName(ext.description)}</p>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <h4 className="font-medium text-fg text-ui-sm">{d.extensions.status}</h4>
        <p className="text-fg-muted text-ui-xs">{extensionStatusLabel(d, ext)}</p>
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium text-fg text-ui-sm">{d.extensions.permissions}</h4>
        <CapabilityList label={d.extensions.approved} caps={ext.granted} />
        {ext.unapproved.length > 0 ? (
          <CapabilityList label={d.extensions.requested} caps={ext.requested} />
        ) : null}
        {ext.unapproved.length > 0 && ext.status !== 'pending-approval' ? (
          <WarningNote>
            {fmt(d.extensions.unapproved, { caps: ext.unapproved.join(', ') })}
          </WarningNote>
        ) : null}
        {needsReview ? (
          <Button variant="outline" size="sm" className="self-start" onClick={() => review(ext.id)}>
            {d.extensions.review}
          </Button>
        ) : null}
      </div>
      <ExtensionAgentPlugin ext={ext} explain={false} />
      <ExtensionSettingsArea ext={ext} />
      <div className="flex items-center gap-2">
        <UninstallExtensionButton extId={ext.id} name={ext.name} />
      </div>
    </section>
  )
}

function ExtensionListRow({
  ext,
  selected,
  onSelect,
}: {
  ext: ExtensionInfo
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const d = useDict()
  const setEnabled = useExtensionsStore((s) => s.setEnabled)
  const Icon = extensionIcon(ext.panel?.icon ?? ext.settingsPage?.icon)
  return (
    <SearchGroup
      texts={[
        ext.name,
        withProductName(ext.description),
        ...ext.settings.map(entryTitle),
        ...ext.secrets.map(entryTitle),
      ]}
    >
      {(search) => (
        <li
          aria-label={ext.name}
          hidden={search.hidden}
          data-search-hit={search.hit || undefined}
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
            <span className="min-w-0 truncate text-fg text-ui-sm">{ext.name}</span>
            <StateChip ext={ext} />
          </button>
          <Switch
            checked={ext.enabled}
            onCheckedChange={(v) => void setEnabled(ext.id, v)}
            aria-label={fmt(d.extensions.enable, { name: ext.name })}
          />
        </li>
      )}
    </SearchGroup>
  )
}

export function ExtensionsSection({
  anchor = null,
}: {
  anchor?: ExtensionAnchor | null
}): JSX.Element {
  const d = useDict()
  const list = useExtensionsStore((s) => s.list)
  useMarketplaceList()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flash, setFlash] = useState<ExtensionAnchor | null>(null)
  const anchorListed = anchor !== null && list.some((e) => e.id === anchor.id)

  useEffect(() => {
    if (!anchor || !anchorListed) return
    setSelectedId(anchor.id)
    setFlash(anchor)
    const timer = setTimeout(() => setFlash(null), ANCHOR_HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [anchor, anchorListed])

  useEffect(() => {
    if (!flash) return
    const details = document.getElementById(extensionAnchorId(flash.id))
    details?.scrollIntoView({ block: 'start' })
    details?.focus({ preventScroll: true })
  }, [flash])

  const selected = list.find((e) => e.id === selectedId) ?? list[0] ?? null

  return (
    <section aria-label={d.extensions.title}>
      <div className="mb-3 flex items-start justify-between gap-6">
        <p className="text-fg-muted text-ui-sm">{d.extensions.desc}</p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => useUIStore.getState().openSettings('browseExtensions')}
        >
          <MagnifyingGlassIcon data-icon="inline-start" />
          {d.extensions.findMore}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.extensions.none}</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-4">
          <ul aria-label={d.extensions.listLabel} className="flex flex-col gap-0.5">
            {list.map((ext) => (
              <ExtensionListRow
                key={ext.id}
                ext={ext}
                selected={ext.id === selected?.id}
                onSelect={() => setSelectedId(ext.id)}
              />
            ))}
          </ul>
          {selected ? <ExtensionDetails key={selected.id} ext={selected} flash={flash} /> : null}
        </div>
      )}
    </section>
  )
}
