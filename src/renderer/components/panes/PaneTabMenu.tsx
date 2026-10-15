import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { MenuContent, MenuItem } from '@/components/common/Menu'
import { FileMenuItems } from '@/components/files/FileMenu'
import { actionIcon } from '@/components/settings/actionIcons'
import { ContextMenu, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { forkConversation, forkableResume } from '@/lib/agents/forkConversation'
import { hibernatableAgentPanes } from '@/lib/agents/hibernationScheduler'
import { useDict } from '@/lib/app/useDict'
import { useChordLabel } from '@/lib/keyboard/chords'
import { canCollapse } from '@/lib/layout/collapse'
import { allPanes, splitTabOfPane } from '@/lib/layout/tree'
import type { PaneNode, SplitNode } from '@/lib/layout/types'
import { runUserAction } from '@/lib/palette/userActions'
import { actionsFor } from '@/lib/settings/actions'
import { closableOtherTabPanes } from '@/lib/workspaces/closeConfirm'
import { canMovePane, movePaneToNewWindow } from '@/lib/workspaces/windowHandoff'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import {
  AppWindowIcon,
  ArrowsInIcon,
  ArrowsInLineHorizontalIcon,
  ArrowsInSimpleIcon,
  ArrowsOutIcon,
  ArrowsOutLineHorizontalIcon,
  ArrowsOutSimpleIcon,
  CaretDoubleLeftIcon,
  GitForkIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  MoonIcon,
  PencilSimpleIcon,
  SunIcon,
  XSquareIcon,
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'
import { TabMoveMenuItems } from './TabMoveMenuItems'

interface CollapseOffers {
  self: boolean
  others: boolean
  all: boolean
}

const NO_COLLAPSE: CollapseOffers = { self: false, others: false, all: false }

function collapseOffers(tab: SplitNode, pane: PaneNode): CollapseOffers {
  const others = allPanes(tab).filter((p) => p.id !== pane.id)
  return {
    self: canCollapse(tab, pane.id),
    others: others.some((p) => !p.collapsed),
    all: pane.collapsed === true || others.some((p) => p.collapsed),
  }
}

export function PaneTabMenu({
  pane,
  workspaceId,
  trigger,
}: {
  pane: PaneNode
  workspaceId: string | null
  trigger: ReactElement
}): JSX.Element {
  const d = useDict()
  const zoomKeys = useChordLabel('pane.zoom', isMac)
  const actions = useSettingsStore((s) => s.actions)
  const tabActions = actionsFor(actions, 'tabMenu', pane.kind)
  const file =
    pane.kind === 'editor' && workspaceId && !isRemotePath(pane.filePath)
      ? pane.filePath
      : undefined
  const movable = workspaceId !== null && canMovePane(workspaceId, pane.id)
  const lockable = workspaceId !== null && pane.kind !== 'manager'
  const zoom = useLayoutStore((s) => {
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined
    if (!layout) return null
    if (layout.zoomedPaneId === pane.id) return 'zoomed'
    const shared = layout.root.type === 'split' || splitTabOfPane(layout.root, pane.id) !== null
    return shared ? 'zoomable' : null
  })
  const otherTabs = useLayoutStore((s) =>
    workspaceId && s.byWorkspace[workspaceId]
      ? closableOtherTabPanes(workspaceId, pane.id).length
      : 0,
  )
  const splitTab = useLayoutStore((s) => {
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined
    return layout ? splitTabOfPane(layout.root, pane.id) : null
  })
  const splitTabId = splitTab?.id ?? null
  const collapse = splitTab ? collapseOffers(splitTab, pane) : NO_COLLAPSE
  const collapseKeys = useChordLabel('pane.collapse', isMac)
  const agentTab = pane.kind === 'terminal' && pane.resume !== undefined
  const renamable = workspaceId !== null
  if (
    !file &&
    tabActions.length === 0 &&
    !movable &&
    !lockable &&
    !zoom &&
    !renamable &&
    otherTabs === 0 &&
    !agentTab
  ) {
    return trigger
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <MenuContent>
        {file && workspaceId ? (
          <FileMenuItems workspaceId={workspaceId} path={file} inOstia />
        ) : null}
        {file && tabActions.length > 0 ? <ContextMenuSeparator /> : null}
        {tabActions.map((action) => (
          <MenuItem
            key={action.id}
            icon={actionIcon(action.icon)}
            onClick={() => void runUserAction(action, pane.id)}
          >
            {action.title}
          </MenuItem>
        ))}
        {(movable || lockable || zoom || renamable) && (file || tabActions.length > 0) ? (
          <ContextMenuSeparator />
        ) : null}
        {renamable ? (
          <MenuItem
            icon={PencilSimpleIcon}
            onClick={() => usePaneRenameStore.getState().begin(pane.id)}
          >
            {d.pane.renameTab}
          </MenuItem>
        ) : null}
        {splitTabId ? (
          <MenuItem
            icon={PencilSimpleIcon}
            onClick={() => usePaneRenameStore.getState().beginSplitTab(splitTabId)}
          >
            {d.pane.renameSplitTab}
          </MenuItem>
        ) : null}
        {splitTabId ? (
          <MenuItem
            icon={CaretDoubleLeftIcon}
            onClick={() => void commands.exec('pane.foldSplitTab', { tabId: splitTabId })}
          >
            {d.pane.foldSplitTab}
          </MenuItem>
        ) : null}
        {zoom ? (
          <MenuItem
            icon={zoom === 'zoomed' ? ArrowsInIcon : ArrowsOutIcon}
            hint={zoomKeys}
            onClick={() => void commands.exec('pane.zoom', { paneId: pane.id })}
          >
            {zoom === 'zoomed' ? d.pane.unzoom : d.pane.zoom}
          </MenuItem>
        ) : null}
        {collapse.self ? (
          <MenuItem
            icon={ArrowsInLineHorizontalIcon}
            hint={collapseKeys}
            onClick={() => void commands.exec('pane.collapse', { paneId: pane.id })}
          >
            {d.pane.collapsePane}
          </MenuItem>
        ) : null}
        {pane.collapsed ? (
          <MenuItem
            icon={ArrowsOutLineHorizontalIcon}
            onClick={() => void commands.exec('pane.focus', { paneId: pane.id })}
          >
            {d.pane.expandPane}
          </MenuItem>
        ) : null}
        {collapse.others ? (
          <MenuItem
            icon={ArrowsInSimpleIcon}
            onClick={() => void commands.exec('pane.collapseOthers', { paneId: pane.id })}
          >
            {d.pane.collapseOtherPanes}
          </MenuItem>
        ) : null}
        {collapse.all ? (
          <MenuItem
            icon={ArrowsOutSimpleIcon}
            onClick={() => void commands.exec('pane.expandAll', { paneId: pane.id })}
          >
            {d.pane.expandAllPanes}
          </MenuItem>
        ) : null}
        {lockable ? (
          <MenuItem
            icon={pane.locked ? LockSimpleOpenIcon : LockSimpleIcon}
            onClick={() => void commands.exec('pane.toggleLock', { paneId: pane.id })}
          >
            {pane.locked ? d.pane.unlock : d.pane.lock}
          </MenuItem>
        ) : null}
        {movable && workspaceId ? (
          <MenuItem
            icon={AppWindowIcon}
            onClick={() => void movePaneToNewWindow(workspaceId, pane.id)}
          >
            {d.window.movePaneToNewWindow}
          </MenuItem>
        ) : null}
        {lockable && workspaceId ? (
          <TabMoveMenuItems workspaceId={workspaceId} tabId={pane.id} />
        ) : null}
        {agentTab && workspaceId ? (
          <TabHibernateItems workspaceId={workspaceId} pane={pane} />
        ) : null}
        {workspaceId && forkableResume(pane) ? (
          <MenuItem icon={GitForkIcon} onClick={() => forkConversation(workspaceId, pane.id)}>
            {d.pane.forkConversation}
          </MenuItem>
        ) : null}
        {otherTabs > 0 ? (
          <MenuItem
            icon={XSquareIcon}
            onClick={() => void commands.exec('tab.closeOthers', { paneId: pane.id })}
          >
            {d.pane.closeOtherTabs}
          </MenuItem>
        ) : null}
      </MenuContent>
    </ContextMenu>
  )
}

function TabHibernateItems({
  workspaceId,
  pane,
}: {
  workspaceId: string
  pane: PaneNode
}): JSX.Element | null {
  const d = useDict()
  if (pane.hibernated) {
    if (pane.resumeFolderMissing) return null
    return (
      <MenuItem icon={SunIcon} onClick={() => void commands.exec('pane.wake', { paneId: pane.id })}>
        {d.pane.wakeTab}
      </MenuItem>
    )
  }
  return (
    <MenuItem
      icon={MoonIcon}
      disabled={!hibernatableAgentPanes(workspaceId).includes(pane.id)}
      onClick={() => void commands.exec('pane.hibernate', { paneId: pane.id })}
    >
      {d.pane.hibernateTab}
    </MenuItem>
  )
}

export function PaneHeaderActions({ pane }: { pane: PaneNode }): JSX.Element {
  const actions = useSettingsStore((s) => s.actions)
  return (
    <>
      {actionsFor(actions, 'paneHeader', pane.kind).map((action) => (
        <IconButton
          key={action.id}
          icon={actionIcon(action.icon)}
          label={action.title}
          onClick={() => void runUserAction(action, pane.id)}
        />
      ))}
    </>
  )
}
