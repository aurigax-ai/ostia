import { ArrowsClockwiseIcon, TrashIcon } from '@phosphor-icons/react'
import { MARKETPLACE_FEATURE, type MarketplaceInfo } from '@shared/marketplace'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
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
import { Button } from './ui/button'
import { Input } from './ui/input'

export function UninstallExtensionButton({
  extId,
  name,
  size = 'sm',
}: {
  extId: string
  name: string
  size?: 'xs' | 'sm'
}): JSX.Element | null {
  const d = useDict()
  const installed = useMarketplaceStore((s) => s.state.installed.includes(extId))
  const busy = useMarketplaceStore((s) => s.busy)
  const uninstall = useMarketplaceStore((s) => s.uninstall)
  const [asking, setAsking] = useState(false)
  if (!installed) return null
  return (
    <>
      <Button variant="outline" size={size} disabled={busy} onClick={() => setAsking(true)}>
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
      className="mt-1 flex items-center gap-2"
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

function RemoveMarketplaceButton({
  marketplace,
}: {
  marketplace: MarketplaceInfo
}): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const remove = useMarketplaceStore((s) => s.remove)
  const [asking, setAsking] = useState(false)
  const removeWith = (uninstallExtensions: boolean): void => {
    setAsking(false)
    void remove(marketplace.id, uninstallExtensions)
  }
  return (
    <>
      <IconButton
        icon={TrashIcon}
        label={fmt(d.marketplace.remove, { name: marketplace.name })}
        disabled={busy}
        onClick={() => {
          if (marketplace.installs.length > 0) setAsking(true)
          else removeWith(false)
        }}
      />
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fmt(d.marketplace.removeTitle, { name: marketplace.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {fmt(d.marketplace.removeBody, { list: marketplace.installs.join(', ') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{d.marketplace.cancel}</AlertDialogCancel>
            <Button variant="outline" size="sm" onClick={() => removeWith(false)}>
              {d.marketplace.keepExtensions}
            </Button>
            <AlertDialogAction size="sm" onClick={() => removeWith(true)}>
              {d.marketplace.uninstallExtensions}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function MarketplaceRow({ marketplace }: { marketplace: MarketplaceInfo }): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const refresh = useMarketplaceStore((s) => s.refresh)
  return (
    <li aria-label={marketplace.name} className="flex flex-col py-2">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-fg text-ui-sm">{marketplace.name}</div>
          <div className="truncate font-mono text-fg-muted text-ui-xs">{marketplace.url}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={ArrowsClockwiseIcon}
            label={fmt(d.marketplace.refresh, { name: marketplace.name })}
            disabled={busy}
            onClick={() => void refresh(marketplace.id)}
          />
          <RemoveMarketplaceButton marketplace={marketplace} />
        </div>
      </div>
      {marketplace.error ? <WarningNote>{marketplace.error}</WarningNote> : null}
      {!marketplace.error && marketplace.extensions.length === 0 ? (
        <p className="mt-0.5 text-fg-muted text-ui-xs">{d.marketplace.noExtensions}</p>
      ) : null}
      {marketplace.unlisted ? <InstallCodeForm marketplace={marketplace} /> : null}
      {marketplace.problems.length > 0 ? (
        <div className="mt-1 text-fg-muted text-ui-xs">
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

export function useMarketplaceList(): MarketplaceInfo[] {
  const marketplaces = useMarketplaceStore((s) => s.state.marketplaces)
  const load = useMarketplaceStore((s) => s.load)
  useEffect(() => {
    if (!useMarketplaceStore.getState().loaded) void load()
    return useExtensionsStore.subscribe((next, previous) => {
      if (next.list !== previous.list) void load()
    })
  }, [load])
  return marketplaces
}

export function MarketplaceFailureNote(): JSX.Element | null {
  const d = useDict()
  const failure = useMarketplaceStore((s) => s.failure)
  if (!failure) return null
  return (
    <WarningNote>
      <p>{d.marketplace.errors[failure.error]}</p>
      {failure.detail ? (
        <p className="mt-1 break-words font-mono text-ui-xs">{failure.detail}</p>
      ) : null}
    </WarningNote>
  )
}

export function MarketplacesPanel(): JSX.Element {
  const d = useDict()
  const marketplaces = useMarketplaceStore((s) => s.state.marketplaces)
  const busy = useMarketplaceStore((s) => s.busy)
  const add = useMarketplaceStore((s) => s.add)
  const [url, setUrl] = useState('')
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
      {marketplaces.length === 0 ? (
        <p className="mt-2 text-fg-muted text-ui-sm">{d.marketplace.none}</p>
      ) : (
        <ul className="mt-1 flex flex-col divide-y divide-line">
          {marketplaces.map((marketplace) => (
            <MarketplaceRow key={marketplace.id} marketplace={marketplace} />
          ))}
        </ul>
      )}
    </section>
  )
}
