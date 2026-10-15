import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { platform } from '@/platform'
import { CheckIcon, CopyIcon, FolderOpenIcon } from '@phosphor-icons/react'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import type { AppInfo, Platform } from '@shared/types'
import { useEffect, useState } from 'react'
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
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    window.ostia
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const name = info?.name ?? PRODUCT_DISPLAY_NAME
  const version = info ? `v${info.version}` : '…'
  return (
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
            void navigator.clipboard.writeText(version).then(() => setCopied(true))
          }}
        />
      </div>
      <p className="text-fg-muted text-ui-sm">
        {fmt(d.settings.copyright, { year: new Date().getFullYear(), name })}
      </p>
      <p className="text-fg-muted text-ui-xs">{PLATFORM_NAMES[platform]}</p>
      <UpdateCheck />
      <Button
        variant="ghost"
        size="sm"
        className="text-fg-muted"
        onClick={() => void window.ostia.diagnostics.openLogFolder()}
      >
        <FolderOpenIcon data-icon="inline-start" aria-hidden />
        {d.crash.openLogs}
      </Button>
    </section>
  )
}
