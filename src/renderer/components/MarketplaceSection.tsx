import { ArrowsClockwiseIcon, TrashIcon } from '@phosphor-icons/react'
import {
  MARKETPLACE_FEATURE,
  type MarketplaceExtension,
  type MarketplaceInfo,
} from '@shared/marketplace'
import { useEffect, useState } from 'react'
import { fmt, useDict, withProductName } from '../i18n/useDict'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useMarketplaceStore } from '../stores/marketplaceStore'
import { IconButton } from './IconButton'
import { RequirementsNote } from './RequirementsNote'
import { SubHead, WarningNote } from './SettingsPanel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function UninstallExtensionButton({
  extId,
  name,
}: {
  extId: string
  name: string
}): JSX.Element | null {
  const d = useDict()
  const installed = useMarketplaceStore((s) => s.state.installed.includes(extId))
  const busy = useMarketplaceStore((s) => s.busy)
  const uninstall = useMarketplaceStore((s) => s.uninstall)
  const [asking, setAsking] = useState(false)
  if (!installed) return null
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setAsking(true)}>
        {d.marketplace.uninstall}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{fmt(d.marketplace.uninstallTitle, { name })}</AlertDialogTitle>
            <AlertDialogDescription>{d.marketplace.uninstallBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{d.marketplace.cancel}</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              onClick={() => {
                setAsking(false)
                void uninstall(extId)
              }}
            >
              {d.marketplace.uninstall}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ExtensionRow({
  marketplace,
  ext,
}: {
  marketplace: MarketplaceInfo
  ext: MarketplaceExtension
}): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const install = useMarketplaceStore((s) => s.install)
  return (
    <li aria-label={ext.name} className="flex items-start justify-between gap-6 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-fg text-ui-base">{ext.name}</span>
          <span className="text-fg-muted text-ui-xs tabular-nums">{ext.version}</span>
          <Badge variant="outline" className="text-ui-xs">
            {d.extensions.categories[ext.category]}
          </Badge>
          {ext.state === 'installed' || ext.state === 'update' ? (
            <Badge variant="outline" className="text-ui-xs">
              {ext.state === 'update' && ext.installedVersion
                ? fmt(d.marketplace.installedVersion, { version: ext.installedVersion })
                : d.marketplace.installed}
            </Badge>
          ) : null}
        </div>
        {ext.description ? (
          <p className="mt-0.5 text-fg-muted text-ui-sm">{withProductName(ext.description)}</p>
        ) : null}
        <p className="mt-0.5 text-fg-muted text-ui-xs">
          {ext.runsProcess ? d.marketplace.runsProcess : d.marketplace.dataOnly} ·{' '}
          {fmt(d.extensions.permissionsList, {
            list:
              ext.capabilities.length > 0
                ? ext.capabilities.join(', ')
                : d.extensions.noPermissions,
          })}
        </p>
        {ext.state === 'conflict' ? (
          <p className="mt-0.5 text-attn-fg text-ui-xs">{d.marketplace.conflict}</p>
        ) : null}
      </div>
      {ext.state === 'available' || ext.state === 'update' ? (
        <Button
          variant={ext.state === 'update' ? 'default' : 'outline'}
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={() => void install(marketplace.id, ext.id)}
        >
          {ext.state === 'update'
            ? fmt(d.marketplace.update, { version: ext.version })
            : d.marketplace.install}
        </Button>
      ) : null}
    </li>
  )
}

function InstallCodeForm({ marketplace }: { marketplace: MarketplaceInfo }): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const installCode = useMarketplaceStore((s) => s.installCode)
  const [code, setCode] = useState('')
  const submit = async (): Promise<void> => {
    if (!code.trim() || busy) return
    if (await installCode(marketplace.id, code)) setCode('')
  }
  return (
    <form
      className="flex items-center gap-2 border-line border-t px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={d.marketplace.codePlaceholder}
        aria-label={fmt(d.marketplace.codeLabel, { name: marketplace.name })}
        className="h-7 flex-1 font-mono"
      />
      <Button type="submit" variant="outline" size="sm" disabled={busy || !code.trim()}>
        {d.marketplace.install}
      </Button>
    </form>
  )
}

function MarketplaceCard({ marketplace }: { marketplace: MarketplaceInfo }): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const refresh = useMarketplaceStore((s) => s.refresh)
  const remove = useMarketplaceStore((s) => s.remove)
  return (
    <li aria-label={marketplace.name} className="rounded-sm border border-line">
      <div className="flex items-start justify-between gap-6 border-line border-b px-3 py-2">
        <div className="min-w-0">
          <div className="text-fg text-ui-base">{marketplace.name}</div>
          <div className="truncate font-mono text-fg-muted text-ui-xs">{marketplace.url}</div>
          {marketplace.description ? (
            <p className="mt-0.5 text-fg-muted text-ui-sm">{marketplace.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={ArrowsClockwiseIcon}
            label={fmt(d.marketplace.refresh, { name: marketplace.name })}
            disabled={busy}
            onClick={() => void refresh(marketplace.id)}
          />
          <IconButton
            icon={TrashIcon}
            label={fmt(d.marketplace.remove, { name: marketplace.name })}
            disabled={busy}
            onClick={() => void remove(marketplace.id)}
          />
        </div>
      </div>
      {marketplace.error ? (
        <div className="px-3 py-2">
          <WarningNote>{marketplace.error}</WarningNote>
        </div>
      ) : marketplace.extensions.length === 0 ? (
        <p className="px-3 py-2 text-fg-muted text-ui-sm">{d.marketplace.noExtensions}</p>
      ) : (
        <ul className="flex flex-col">
          {marketplace.extensions.map((ext) => (
            <ExtensionRow key={ext.id} marketplace={marketplace} ext={ext} />
          ))}
        </ul>
      )}
      {marketplace.unlisted ? <InstallCodeForm marketplace={marketplace} /> : null}
      {marketplace.problems.length > 0 ? (
        <div className="border-line border-t px-3 py-2 text-fg-muted text-ui-xs">
          <div>{d.marketplace.problems}</div>
          <ul className="mt-0.5 font-mono">
            {marketplace.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

export function MarketplaceSection(): JSX.Element {
  const d = useDict()
  const marketplaces = useMarketplaceStore((s) => s.state.marketplaces)
  const busy = useMarketplaceStore((s) => s.busy)
  const failure = useMarketplaceStore((s) => s.failure)
  const load = useMarketplaceStore((s) => s.load)
  const add = useMarketplaceStore((s) => s.add)
  const [url, setUrl] = useState('')
  useEffect(() => {
    void load()
    return useExtensionsStore.subscribe((next, previous) => {
      if (next.list !== previous.list) void load()
    })
  }, [load])
  const submit = async (): Promise<void> => {
    if (!url.trim() || busy) return
    if (await add(url)) setUrl('')
  }
  return (
    <section aria-label={d.marketplace.title}>
      <SubHead title={d.marketplace.title} desc={d.marketplace.desc} />
      <RequirementsNote feature={MARKETPLACE_FEATURE} body={d.marketplace.requirementsBody} />
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={d.marketplace.addPlaceholder}
          aria-label={d.marketplace.addLabel}
          className="h-7 flex-1 font-mono"
        />
        <Button type="submit" variant="outline" size="sm" disabled={busy || !url.trim()}>
          {busy ? d.marketplace.working : d.marketplace.add}
        </Button>
      </form>
      {failure ? (
        <WarningNote>
          <p>{d.marketplace.errors[failure.error]}</p>
          {failure.detail ? (
            <p className="mt-1 break-words font-mono text-ui-xs">{failure.detail}</p>
          ) : null}
        </WarningNote>
      ) : null}
      {marketplaces.length === 0 ? (
        <p className="mt-3 text-fg-muted text-ui-sm">{d.marketplace.none}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {marketplaces.map((marketplace) => (
            <MarketplaceCard key={marketplace.id} marketplace={marketplace} />
          ))}
        </ul>
      )}
    </section>
  )
}
