import { GearSixIcon, MagnifyingGlassIcon, SidebarSimpleIcon } from '@phosphor-icons/react'
import { useDict } from '../i18n/useDict'
import { chordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useUIStore } from '../stores/uiStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { NotificationCenter } from './NotificationCenter'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'

const PALETTE_KEYS = chordLabel('palette.toggle', isMac)

export function TopBar(): JSX.Element {
  const d = useDict()
  const toggleRail = useUIStore((s) => s.toggleRail)
  const openSettings = useUIStore((s) => s.openSettings)
  const openPalette = useUIStore((s) => s.openPalette)

  return (
    <header className="topbar drag-region">
      <div className="topbar-left">
        <IconButton
          size="bar"
          icon={SidebarSimpleIcon}
          label={d.topbar.toggleSidebar}
          onClick={toggleRail}
        />
        <IconButton
          size="bar"
          icon={GearSixIcon}
          label={d.topbar.settings}
          onClick={openSettings}
        />
      </div>

      <Hint label={`${d.search.placeholder} (${PALETTE_KEYS})`} side="bottom">
        <Button
          variant="outline"
          size="sm"
          className="min-w-0 justify-start font-normal text-fg-muted"
          onClick={openPalette}
        >
          <MagnifyingGlassIcon data-icon="inline-start" />
          <span className="flex-1 truncate text-left">{d.search.command}</span>
          <Kbd>{PALETTE_KEYS}</Kbd>
        </Button>
      </Hint>

      <div className="topbar-right">
        <NotificationCenter />
      </div>
    </header>
  )
}
