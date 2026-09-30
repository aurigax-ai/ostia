import {
  FolderSimpleIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SidebarSimpleIcon,
} from '@phosphor-icons/react'
import { useDict } from '../i18n/useDict'
import { useChordLabel } from '../lib/chords'
import { startNewWorkspace } from '../lib/newWorkspace'
import { isMac } from '../platform'
import { useUIStore } from '../stores/uiStore'
import { AssistantMenu } from './AssistantMenu'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { NotificationCenter } from './NotificationCenter'
import { PanelToggles } from './PanelToggles'
import { UpdateNotice } from './UpdateNotice'
import { Button } from './ui/button'
import { Kbd } from './ui/kbd'

export function TopBar(): JSX.Element {
  const d = useDict()
  const toggleRail = useUIStore((s) => s.toggleRail)
  const openPalette = useUIStore((s) => s.openPalette)
  const openSettings = useUIStore((s) => s.openSettings)
  const leaveSettings = useUIStore((s) => s.leaveSettings)
  const filesOpen = useUIStore((s) => s.filesOpen)
  const toggleFiles = useUIStore((s) => s.toggleFiles)
  const paletteKeys = useChordLabel('palette.toggle', isMac)

  return (
    <header className="topbar drag-region">
      <div className="topbar-left">
        <IconButton
          size="bar"
          icon={PlusIcon}
          label={d.rail.newWorkspace}
          onClick={() => {
            leaveSettings()
            startNewWorkspace()
          }}
        />
        <IconButton
          size="bar"
          icon={SidebarSimpleIcon}
          label={d.topbar.toggleSidebar}
          onClick={toggleRail}
        />
        <IconButton
          size="bar"
          icon={FolderSimpleIcon}
          label={d.rail.files}
          aria-pressed={filesOpen}
          onClick={toggleFiles}
        />
        <PanelToggles />
      </div>

      <div className="topbar-center">
        <Hint
          label={paletteKeys ? `${d.search.placeholder} (${paletteKeys})` : d.search.placeholder}
          side="bottom"
        >
          <Button
            variant="ghost"
            className="h-6 min-w-0 flex-1 justify-start gap-1 rounded-sm bg-fg/6 pr-1 pl-2 font-normal text-fg-muted text-ui-base hover:bg-fg/10 hover:text-fg dark:hover:bg-fg/10"
            onClick={() => openPalette()}
          >
            <MagnifyingGlassIcon className="size-3.5" />
            <span className="flex-1 truncate text-left">{d.search.command}</span>
            {paletteKeys ? (
              <Kbd className="h-4 bg-transparent font-mono text-ui-xs">{paletteKeys}</Kbd>
            ) : null}
          </Button>
        </Hint>
        <AssistantMenu />
      </div>

      <div className="topbar-right">
        <UpdateNotice />
        <IconButton
          size="bar"
          icon={GearSixIcon}
          label={d.topbar.settings}
          onClick={() => openSettings()}
        />
        <NotificationCenter />
      </div>
    </header>
  )
}
