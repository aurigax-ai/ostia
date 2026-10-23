import { ArrowsClockwiseIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import {
  MARKETPLACE_FEATURE,
  type MarketplaceExtension,
  type MarketplaceInfo,
} from '@shared/extensions/marketplace'
import { useEffect, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { MachineValue } from '@/components/common/MachineValue'
import { Notice } from '@/components/common/Notice'
import { RequirementsNote } from '@/components/settings/RequirementsNote'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { RowRemoveButton } from '@/components/settingsKit/RowRemoveButton'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import { parseDevSource } from '@/lib/extensions/devSource'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useMarketplaceStore } from '@/stores/extensions/marketplaceStore'

export function marketplaceName(d: Dict, marketplace: MarketplaceInfo): string {
  return marketplace.official ? d.marketplace.officialName : marketplace.name
}

export function UninstallExtensionButton({
  extId,
  name,
  icon,
}: {
  extId: string
  name: string
  icon?: boolean
}): JSX.Element | null {
  const d = useDict()
  const installed = useMarketplaceStore((s) => s.state.installed.includes(extId))
  const busy = useMarketplaceStore((s) => s.busy)
  const uninstall = useMarketplaceStore((s) => s.uninstall)
  const [asking, setAsking] = useState(false)
  if (!installed) return null
  return (
    <>
      {icon ? (
        <RowRemoveButton
          label={fmt(d.marketplace.uninstallLabel, { name })}
          disabled={busy}
          onClick={() => setAsking(true)}
        />
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setAsking(true)}>
          {d.marketplace.uninstall}
        </Button>
      )}
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
              variant="destructive"
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

export function UpdateExtensionButton({
  marketplaceId,
  ext,
}: {
  marketplaceId: string
  ext: MarketplaceExtension
}): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const install = useMarketplaceStore((s) => s.install)
  const [asking, setAsking] = useState(false)
  if (!ext.downgrade) {
    return (
      <Button size="sm" disabled={busy} onClick={() => void install(marketplaceId, ext.id)}>
        {fmt(d.extensions.updateTo, { version: ext.version })}
      </Button>
    )
  }
  return (
    <>
      <Button size="sm" disabled={busy} onClick={() => setAsking(true)}>
        {fmt(d.extensions.switchTo, { version: ext.version })}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fmt(d.marketplace.downgradeTitle, { name: ext.name, version: ext.version })}
            </AlertDialogTitle>
            <AlertDialogDescription>{d.marketplace.downgradeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">{d.marketplace.cancel}</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              onClick={() => {
                setAsking(false)
                void install(marketplaceId, ext.id, true)
              }}
            >
              {fmt(d.extensions.switchTo, { version: ext.version })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function RemoveMarketplaceButton({ marketplace }: { marketplace: MarketplaceInfo }): JSX.Element {
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
      <RowRemoveButton
        label={fmt(d.marketplace.remove, { name: marketplaceName(d, marketplace) })}
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
              {fmt(d.marketplace.removeTitle, { name: marketplaceName(d, marketplace) })}
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
            <AlertDialogAction size="sm" variant="destructive" onClick={() => removeWith(true)}>
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
  const name = marketplaceName(d, marketplace)
  const empty = marketplace.downloaded && !marketplace.error && marketplace.extensions.length === 0
  return (
    <SettingsListRow
      aria-label={name}
      title={name}
      detail={
        <>
          {name === marketplace.url ? null : (
            <div className="flex min-w-0">
              <MachineValue value={marketplace.url} />
            </div>
          )}
          {marketplace.downloaded ? null : <p>{d.marketplace.notDownloaded}</p>}
          {empty ? <p>{d.marketplace.noExtensions}</p> : null}
          {marketplace.error ? <Notice>{marketplace.error}</Notice> : null}
        </>
      }
      actions={
        <>
          {marketplace.downloaded ? (
            <IconButton
              icon={ArrowsClockwiseIcon}
              label={fmt(d.marketplace.refresh, { name })}
              disabled={busy}
              onClick={() => void refresh(marketplace.id)}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void refresh(marketplace.id)}
            >
              {d.marketplace.download}
            </Button>
          )}
          {marketplace.official ? null : <RemoveMarketplaceButton marketplace={marketplace} />}
        </>
      }
    />
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
    <Notice>
      <p>{d.marketplace.errors[failure.error]}</p>
      {failure.detail ? (
        <p className="mt-1 break-words font-mono text-ui-xs">{failure.detail}</p>
      ) : null}
    </Notice>
  )
}

function DevInstallRow(): JSX.Element {
  const d = useDict()
  const busy = useMarketplaceStore((s) => s.busy)
  const installDev = useMarketplaceStore((s) => s.installDev)
  const [text, setText] = useState('')
  const source = parseDevSource(text)
  const submit = async (): Promise<void> => {
    if (!source || busy) return
    if (await installDev(source)) setText('')
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <ControlRow label={d.marketplace.devTitle} desc={d.marketplace.devDesc}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={d.marketplace.devPlaceholder}
          aria-label={d.marketplace.devLabel}
          className="h-7 w-56 font-mono"
        />
        <Button type="submit" variant="outline" size="sm" disabled={busy || !source}>
          {d.marketplace.devInstall}
        </Button>
      </ControlRow>
    </form>
  )
}

export function MarketplacesGroup(): JSX.Element {
  const d = useDict()
  const marketplaces = useMarketplaceList()
  const busy = useMarketplaceStore((s) => s.busy)
  const add = useMarketplaceStore((s) => s.add)
  const [url, setUrl] = useState('')
  const submit = async (): Promise<void> => {
    if (!url.trim() || busy) return
    if (await add(url)) setUrl('')
  }
  return (
    <SettingsGroup title={d.marketplace.title}>
      <RequirementsNote feature={MARKETPLACE_FEATURE} body={d.marketplace.requirementsBody} />
      <MarketplaceFailureNote />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <ControlRow label={d.marketplace.addTitle} desc={d.marketplace.addDesc}>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={d.marketplace.addPlaceholder}
            aria-label={d.marketplace.addLabel}
            className="h-7 w-56 font-mono"
          />
          <Button type="submit" variant="outline" size="sm" disabled={busy || !url.trim()}>
            {busy ? d.marketplace.working : d.marketplace.add}
          </Button>
        </ControlRow>
      </form>
      <DevInstallRow />
      <SettingsList label={d.marketplace.title} empty={d.marketplace.none}>
        {marketplaces.map((marketplace) => (
          <MarketplaceRow key={marketplace.id} marketplace={marketplace} />
        ))}
      </SettingsList>
    </SettingsGroup>
  )
}
