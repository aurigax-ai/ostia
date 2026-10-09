import { DashboardButton } from '@/components/agents/DashboardButton'
import { NotificationCenter } from '@/components/agents/NotificationCenter'
import { AssistantMenu } from '@/components/assist/AssistantMenu'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem, MenuSubContent, MenuSubTrigger } from '@/components/common/Menu'
import { WorkspaceChips } from '@/components/extensions/ExtensionChips'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { ContextMenuSeparator, ContextMenuSub } from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { useDict } from '@/i18n/useDict'
import { useChordLabel } from '@/lib/chords'
import { startNewWorkspace, startScratchWorkspace } from '@/lib/newWorkspace'
import { type SshHosts, listSshHosts, openSshWorkspace, sshEnabled } from '@/lib/sshWorkspace'
import { isMac } from '@/platform'
import { useExtensionsStore } from '@/stores/extensionsStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import {
  CaretDownIcon,
  FlaskIcon,
  FolderSimpleIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
  PlusIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
} from '@phosphor-icons/react'
import { useState } from 'react'
import { PanelToggles } from './PanelToggles'
import { UpdateNotice } from './UpdateNotice'
import { ZoomReset } from './ZoomReset'

export function TopBar(): JSX.Element {
  const d = useDict()
  const toggleRail = useUIStore((s) => s.toggleRail)
  const openPalette = useUIStore((s) => s.openPalette)
  const openSettings = useUIStore((s) => s.openSettings)
  const showWorkspaces = useUIStore((s) => s.showWorkspaces)
  const filesOpen = useUIStore((s) => s.filesOpen)
  const toggleFiles = useUIStore((s) => s.toggleFiles)
  const paletteKeys = useChordLabel('palette.searchEverywhere', isMac)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const dashboardActive = useUIStore((s) => s.dashboardActive)

  return (
    <header className="topbar drag-region">
      <div className="topbar-left">
        <ButtonGroup aria-label={d.rail.newWorkspace} className="topbar-split rounded-sm">
          <IconButton
            size="bar"
            icon={PlusIcon}
            label={d.rail.newWorkspace}
            command="workspace.new"
            className="rounded-r-none"
            onClick={() => {
              showWorkspaces()
              startNewWorkspace()
            }}
          />
          <NewWorkspaceMenu />
        </ButtonGroup>
        <IconButton
          size="bar"
          icon={SidebarSimpleIcon}
          label={d.topbar.toggleSidebar}
          command="view.toggleRail"
          onClick={toggleRail}
        />
        <IconButton
          size="bar"
          icon={FolderSimpleIcon}
          label={d.rail.files}
          aria-pressed={filesOpen}
          onClick={toggleFiles}
        />
        <DashboardButton />
        <PanelToggles />
      </div>

      <div className="topbar-center">
        <Hint
          label={d.palette.everywherePlaceholder}
          command="palette.searchEverywhere"
          side="bottom"
        >
          <Button
            variant="ghost"
            className="h-6 min-w-0 flex-1 justify-start gap-1 rounded-sm bg-fg/6 pr-1 pl-2 font-normal text-fg-muted text-ui-base hover:bg-fg/10 hover:text-fg dark:hover:bg-fg/10"
            onClick={() => openPalette('everywhere')}
          >
            <MagnifyingGlassIcon className="size-3.5" />
            <span className="flex-1 truncate text-left">{d.search.command}</span>
            {paletteKeys ? <Kbd className="h-4 bg-transparent">{paletteKeys}</Kbd> : null}
          </Button>
        </Hint>
        <AssistantMenu />
      </div>

      <div className="topbar-right">
        <WorkspaceChips workspaceId={dashboardActive ? null : activeWorkspaceId} />
        <ZoomReset />
        <UpdateNotice />
        <IconButton
          size="bar"
          icon={GearSixIcon}
          label={d.topbar.settings}
          command="app.openSettings"
          onClick={() => openSettings()}
        />
        <NotificationCenter />
      </div>
    </header>
  )
}

function NewWorkspaceMenu(): JSX.Element {
  const d = useDict()
  const showWorkspaces = useUIStore((s) => s.showWorkspaces)
  const ssh = useExtensionsStore((s) => sshEnabled(s.list))
  const [hosts, setHosts] = useState<SshHosts | null | 'loading'>('loading')
  const scratch = (sandboxed: boolean): void => {
    showWorkspaces()
    void startScratchWorkspace({ sandboxed })
  }
  const loadHosts = (open: boolean): void => {
    if (!open || !ssh) return
    setHosts('loading')
    void listSshHosts().then(setHosts)
  }
  return (
    <DropdownMenu
      align="start"
      onOpenChange={loadHosts}
      trigger={
        <IconButton
          size="bar"
          icon={CaretDownIcon}
          label={d.scratch.newMenu}
          className="topbar-split-caret w-4 rounded-l-none"
        />
      }
    >
      <MenuItem
        icon={PlusIcon}
        onClick={() => {
          showWorkspaces()
          startNewWorkspace()
        }}
      >
        {d.rail.newWorkspace}
      </MenuItem>
      <MenuItem icon={FlaskIcon} onClick={() => scratch(false)}>
        {d.scratch.newScratch}
      </MenuItem>
      <MenuItem icon={ShieldCheckIcon} onClick={() => scratch(true)}>
        {d.scratch.newSandboxedScratch}
      </MenuItem>
      {ssh ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <MenuSubTrigger icon={PlugsConnectedIcon}>{d.scratch.ssh}</MenuSubTrigger>
            <MenuSubContent className="max-h-96 max-w-80 overflow-y-auto">
              <SshHostItems
                hosts={hosts}
                onPick={(host) => {
                  showWorkspaces()
                  void openSshWorkspace(host)
                }}
              />
            </MenuSubContent>
          </ContextMenuSub>
        </>
      ) : null}
    </DropdownMenu>
  )
}

function SshHostItems({
  hosts,
  onPick,
}: {
  hosts: SshHosts | null | 'loading'
  onPick: (host: string) => void
}): JSX.Element {
  const d = useDict()
  if (hosts === 'loading') return <MenuItem disabled>{d.scratch.sshLoading}</MenuItem>
  if (hosts === null || hosts.hosts.length === 0) {
    return <MenuItem disabled>{d.scratch.sshEmpty}</MenuItem>
  }
  return (
    <>
      {hosts.hosts.map((host) => (
        <MenuItem key={host} onClick={() => onPick(host)}>
          {host}
        </MenuItem>
      ))}
      {hosts.truncated ? <MenuItem disabled>{d.scratch.sshTruncated}</MenuItem> : null}
    </>
  )
}
