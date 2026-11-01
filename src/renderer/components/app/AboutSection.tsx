import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { CheckIcon, CopyIcon, FolderOpenIcon } from '@phosphor-icons/react'
import type { AppInfo, Platform } from '@shared/types'
import { type JSX, useEffect, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { Button } from '@/components/ui/button'
import { useCopied } from '@/lib/app/useCopied'
import { fmt, useDict } from '@/lib/app/useDict'
import { platform } from '@/platform'
import appIcon from '../../../../resources/icon.svg'
import { UpdateCheck } from './UpdateCheck'

const PLATFORM_NAMES: Record<Platform, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
}

export function AboutSection(): JSX.Element {
  const d = useDict()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, markCopied] = useCopied()
  useEffect(() => {
    window.ostia
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  const name = info?.name ?? PRODUCT_DISPLAY_NAME
  const version = info ? `v${info.version}` : '…'
  return (
    <>
      <section
        aria-label={d.settings.about}
        className="flex flex-col items-center gap-3 pt-16 text-center"
      >
        <img src={appIcon} alt="" className="size-20" />
        <h2 className="font-semibold text-fg text-ui-lg">{name}</h2>
        <div className="flex items-center gap-1">
          <span className="text-fg-muted text-ui-sm tabular-nums">{version}</span>
          <IconButton
            icon={copied ? CheckIcon : CopyIcon}
            label={copied ? d.settings.copied : d.settings.copyVersion}
            disabled={!info}
            onClick={() => {
              void navigator.clipboard.writeText(version).then(markCopied)
            }}
          />
        </div>
        <p className="text-fg-muted text-ui-sm">
          {fmt(d.settings.copyright, { year: new Date().getFullYear(), name })}
        </p>
      </section>
      <AboutRows />
    </>
  )
}

function AboutRows(): JSX.Element {
  const d = useDict()
  return (
    <div className="mt-10">
      <SettingsGroup title={d.settings.groupUpdates}>
        <UpdateCheck />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupComputer}>
        <ControlRow label={d.settings.operatingSystem}>
          <span className="text-fg-muted text-ui-sm">{PLATFORM_NAMES[platform]}</span>
        </ControlRow>
        <ControlRow label={d.settings.log} desc={d.settings.logDesc}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void window.ostia.diagnostics.openLogFolder()}
          >
            <FolderOpenIcon data-icon="inline-start" aria-hidden />
            {d.crash.openLogs}
          </Button>
        </ControlRow>
      </SettingsGroup>
    </div>
  )
}
