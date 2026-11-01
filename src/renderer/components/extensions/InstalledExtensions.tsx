import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { FileKindInfo } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { GearIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { MarketplaceExtension } from '@shared/extensions/marketplace'
import { type JSX, useEffect, useState } from 'react'
import { isAssistExtension } from '@/components/assist/AssistantSection'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { LanguageServerRows } from '@/components/languageServers/LanguageServerRows'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup, SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SearchGroup } from '@/components/settingsKit/SettingsSearch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useReducedMotion } from '@/lib/app/motion'
import { fmt, useDict, withProductName } from '@/lib/app/useDict'
import { firstSentence } from '@/lib/extensions/extensionBrowse'
import { entryTitle } from '@/lib/extensions/extensionSettingText'
import { kindText } from '@/lib/extensions/kindText'
import { extensionAnchorId } from '@/lib/settings/settingsNav'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'
import { ExtensionAgentPlugin } from './ExtensionAgentPlugin'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { ExtensionTile } from './ExtensionTile'
import {
  marketplaceName,
  UninstallExtensionButton,
  UpdateExtensionButton,
  useMarketplaceList,
} from './MarketplaceSection'

export interface ExtensionAnchor {
  id: string
  nonce: number
}

const ANCHOR_HIGHLIGHT_MS = 2000

function unapprovedKinds(ext: ExtensionInfo): FileKindInfo[] {
  return ext.fileKinds.filter((kind) => !kind.approved)
}

function awaitsReview(ext: ExtensionInfo): boolean {
  return ext.unapproved.length > 0 || unapprovedKinds(ext).length > 0
}

function awaitsApproval(ext: ExtensionInfo): boolean {
  return ext.status === 'pending-approval' || awaitsReview(ext)
}

function ProblemChip({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  if (ext.status !== 'crashed') return null
  return (
    <Badge variant="secondary" className="ml-2 text-ui-xs text-warn-fg">
      {d.extensions.stateProblem}
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
  const dev = useMarketplaceStore((s) => s.state.dev[ext.id])
  const owner = marketplaces.find((m) => m.installs.includes(ext.id))
  if (ext.builtin) {
    return owner
      ? fmt(d.extensions.sourceBuiltinUpdated, { name: marketplaceName(d, owner) })
      : d.extensions.sourceBuiltin
  }
  if (dev) return fmt(d.extensions.sourceDev, { source: dev })
  if (owner) return fmt(d.extensions.sourceMarketplace, { name: marketplaceName(d, owner) })
  return fromMarketplace ? d.extensions.sourceOrphaned : d.extensions.sourceManual
}

function Value({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="text-fg-muted text-ui-sm tabular-nums">{children}</span>
}

function PermissionRows({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const waitingKinds = unapprovedKinds(ext).map((kind) => kind.displayName)
  return (
    <>
      <SettingsSubgroup title={d.extensions.permissions} />
      {ext.granted.length === 0 && ext.unapproved.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{d.extensions.noPermissions}</p>
      ) : null}
      {ext.granted.map((cap) => (
        <ControlRow key={cap} label={cap} desc={d.extensions.capabilityAllows[cap] ?? cap}>
          <Badge variant="outline" className="text-ui-xs">
            {d.extensions.approved}
          </Badge>
        </ControlRow>
      ))}
      {ext.unapproved.map((cap) => (
        <ControlRow key={cap} label={cap} desc={d.extensions.capabilityAllows[cap] ?? cap}>
          <Badge variant="secondary" className="text-ui-xs">
            {d.extensions.requested}
          </Badge>
        </ControlRow>
      ))}
      {ext.unapproved.length > 0 && ext.status !== 'pending-approval' ? (
        <Notice>{fmt(d.extensions.unapproved, { caps: ext.unapproved.join(', ') })}</Notice>
      ) : null}
      {waitingKinds.length > 0 && ext.status !== 'pending-approval' ? (
        <Notice>{fmt(d.extensions.unapprovedKinds, { kinds: waitingKinds.join(', ') })}</Notice>
      ) : null}
    </>
  )
}

function ExtensionSettingsArea({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  if (isAssistExtension(ext) && !ext.settingsPage && !ext.enabled) return null
  return (
    <>
      <div className="mt-3" />
      <SettingsSubgroup title={d.extensions.groupSettings} />
      <ExtensionSettingsContent ext={ext} />
    </>
  )
}

function ExtensionSettingsContent({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  if (ext.settingsPage) {
    return (
      <ControlRow label={d.extensions.groupSettings}>
        <TextLink
          size="xs"
          className="h-5 px-0 text-ui-sm"
          onClick={() => useUIStore.getState().openSettings('extensions', { extension: ext.id })}
        >
          {d.extensions.openSettingsPage}
        </TextLink>
      </ControlRow>
    )
  }
  if (isAssistExtension(ext)) {
    return (
      <ControlRow label={d.extensions.groupSettings}>
        <TextLink
          size="xs"
          className="h-5 px-0 text-ui-sm"
          onClick={() => useUIStore.getState().openSettings('assistant')}
        >
          {d.assistantSettings.configure}
        </TextLink>
      </ControlRow>
    )
  }
  if (ext.settings.length === 0 && ext.secrets.length === 0) {
    return <p className="py-1.5 text-fg-muted text-ui-sm">{d.extensions.noSettings}</p>
  }
  return <ExtensionSettingsForm ext={ext} bare />
}

function FileKindRows({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  if (ext.fileKinds.length === 0) return null
  return (
    <>
      <div className="mt-3" />
      <SettingsSubgroup title={d.extensions.fileKinds} />
      {ext.fileKinds.map((kind) => (
        <ControlRow key={kind.id} label={kind.displayName} desc={kindText(d, kind)}>
          <Badge variant={kind.approved ? 'outline' : 'secondary'} className="text-ui-xs">
            {kind.approved ? d.extensions.approved : d.extensions.requested}
          </Badge>
        </ControlRow>
      ))}
    </>
  )
}

function PrereleaseRow({ extId }: { extId: string }): JSX.Element | null {
  const d = useDict()
  const owned = useMarketplaceStore((s) =>
    s.state.marketplaces.some((m) => m.installs.includes(extId)),
  )
  const enabled = useMarketplaceStore((s) => s.state.prerelease.includes(extId))
  const busy = useMarketplaceStore((s) => s.busy)
  const setPrerelease = useMarketplaceStore((s) => s.setPrerelease)
  if (!owned) return null
  return (
    <ControlRow label={d.extensions.prerelease} desc={d.extensions.prereleaseDesc}>
      <Switch
        checked={enabled}
        disabled={busy}
        onCheckedChange={(v) => void setPrerelease(extId, v)}
        aria-label={d.extensions.prerelease}
      />
    </ControlRow>
  )
}

function ExtensionDetails({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const description = withProductName(ext.description)
  return (
    <>
      {description ? <p className="mb-2 text-fg text-ui-sm">{description}</p> : null}
      <SettingsSubgroup title={d.extensions.groupDetails} />
      <ControlRow label={d.extensions.categoryLabel}>
        <Value>{d.extensions.categories[ext.category]}</Value>
      </ControlRow>
      <ControlRow label={d.extensions.status}>
        <Value>{extensionStatusLabel(d, ext)}</Value>
      </ControlRow>
      <PrereleaseRow extId={ext.id} />
      <div className="mt-3" />
      <PermissionRows ext={ext} />
      <FileKindRows ext={ext} />
      <LanguageServerRows ext={ext} />
      <ExtensionAgentPlugin ext={ext} explain={false} />
      <ExtensionSettingsArea ext={ext} />
    </>
  )
}

function useUpdateOffer(
  extId: string,
): { marketplaceId: string; ext: MarketplaceExtension } | null {
  const marketplaces = useMarketplaceStore((s) => s.state.marketplaces)
  for (const marketplace of marketplaces) {
    const offered = marketplace.extensions.find((e) => e.id === extId && e.state === 'update')
    if (offered) return { marketplaceId: marketplace.id, ext: offered }
  }
  return null
}

function ExtensionListRow({
  ext,
  anchor,
  flashing,
}: {
  ext: ExtensionInfo
  anchor: boolean
  flashing: boolean
}): JSX.Element {
  const d = useDict()
  const setEnabled = useExtensionsStore((s) => s.setEnabled)
  const review = useExtensionsStore((s) => s.review)
  const reducedMotion = useReducedMotion()
  const source = useSourceLabel(ext)
  const offer = useUpdateOffer(ext.id)
  const servers = useLanguageServersStore((s) => s.list)
  const serverTexts = servers
    .filter((server) => server.extId === ext.id)
    .flatMap((server) => [server.name, d.languageServers.kinds[server.kind]])
  return (
    <SearchGroup
      texts={[
        ext.name,
        withProductName(ext.description),
        ...ext.settings.map(entryTitle),
        ...ext.secrets.map(entryTitle),
        ...serverTexts,
      ]}
    >
      {(search) => (
        <SettingsListRow
          id={extensionAnchorId(ext.id)}
          tabIndex={-1}
          aria-label={ext.name}
          hidden={search.hidden}
          data-search-hit={search.hit || undefined}
          className="relative scroll-mt-3 outline-none"
          lead={<ExtensionTile icon={ext.panel?.icon ?? ext.settingsPage?.icon} />}
          title={ext.name}
          meta={
            <>
              {fmt(d.extensions.versionSource, { version: ext.version, source })}
              <ProblemChip ext={ext} />
            </>
          }
          detail={
            <span className="block truncate">
              {firstSentence(withProductName(ext.description))}
            </span>
          }
          actions={(toggle) => (
            <>
              {offer ? (
                <UpdateExtensionButton marketplaceId={offer.marketplaceId} ext={offer.ext} />
              ) : null}
              {awaitsApproval(ext) ? (
                <Button size="sm" onClick={() => review(ext.id)}>
                  {d.extensions.approveRow}
                </Button>
              ) : null}
              {toggle}
              <UninstallExtensionButton extId={ext.id} name={ext.name} icon />
              <Switch
                checked={ext.enabled}
                onCheckedChange={(v) => void setEnabled(ext.id, v)}
                aria-label={fmt(d.extensions.enable, { name: ext.name })}
              />
            </>
          )}
          expandIcon={GearIcon}
          expandLabel={fmt(d.extensions.settingsOf, { name: ext.name })}
          defaultOpen={anchor}
          expanded={<ExtensionDetails ext={ext} />}
          below={
            flashing ? (
              <span
                aria-hidden
                data-testid="extension-anchor-highlight"
                className={cn(
                  'settings-anchor-highlight pointer-events-none absolute inset-0 rounded-sm',
                  reducedMotion && 'settings-anchor-highlight-static',
                )}
              />
            ) : undefined
          }
        />
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
  const [flash, setFlash] = useState<ExtensionAnchor | null>(null)
  const anchorListed = anchor !== null && list.some((e) => e.id === anchor.id)

  useEffect(() => {
    if (!anchor || !anchorListed) return
    setFlash(anchor)
    const timer = setTimeout(() => setFlash(null), ANCHOR_HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [anchor, anchorListed])

  useEffect(() => {
    if (!flash) return
    const row = document.getElementById(extensionAnchorId(flash.id))
    row?.scrollIntoView({ block: 'start' })
    row?.focus({ preventScroll: true })
  }, [flash])

  return (
    <SettingsGroup title={d.extensions.groupInstalled}>
      <SettingsList label={d.extensions.listLabel} empty={d.extensions.none}>
        {list.map((ext) => (
          <ExtensionListRow
            key={`${ext.id}:${anchor?.id === ext.id ? anchor.nonce : 0}`}
            ext={ext}
            anchor={anchor?.id === ext.id}
            flashing={flash?.id === ext.id}
          />
        ))}
      </SettingsList>
    </SettingsGroup>
  )
}
