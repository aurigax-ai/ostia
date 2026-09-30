import {
  ArrowSquareOutIcon,
  CodeIcon,
  CopyIcon,
  EyeIcon,
  EyeSlashIcon,
  FileIcon,
  FolderOpenIcon,
  PaperPlaneTiltIcon,
  SquareSplitHorizontalIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'
import { externalEditorError } from '../commands/externalEditor'
import { currentDict, fmt, useDict } from '../i18n/useDict'
import { relativePath } from '../lib/fileReference'
import { startNewWorkspace } from '../lib/newWorkspace'
import { openFileBeside, openFileInWorkspace, openTerminalIn } from '../lib/openFile'
import type { PickTarget } from '../lib/pickTargets'
import { insertPathReference } from '../lib/sendPick'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { MenuContent, MenuItem, MenuSubContent, MenuSubTrigger } from './Menu'
import { useAgentTargets } from './PickSendPanel'
import {
  ContextMenu,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuTrigger,
} from './ui/context-menu'

function sendPath(target: PickTarget, path: string): void {
  if (!insertPathReference(target.paneId, path)) return
  if (!target.sameWorkspace) return
  useLayoutStore.getState().focusPane(target.workspaceId, target.paneId)
  requestAnimationFrame(() => focusSurface(target.paneId))
}

function openInNewWorkspace(path: string, dir: boolean): void {
  useUIStore.getState().leaveSettings()
  startNewWorkspace({ dir: dir ? path : parentOf(path) })
  if (!dir) openFileInWorkspace(path)
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : '/'
}

function report(workspaceId: string, message: string): void {
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
  if (!paneId) {
    console.error(`[files] ${message}`)
    return
  }
  window.pine.notifications.post({ paneId, kind: 'error', title: message, desktop: false })
}

function openDefault(workspaceId: string, path: string): void {
  void window.pine.openPath.openDefault(path).then((res) => {
    if (res.ok) return
    const d = currentDict()
    report(
      workspaceId,
      res.error === 'program' ? d.fileMenu.refusedProgram : fmt(d.fileMenu.openFailed, { path }),
    )
  })
}

function openExternal(workspaceId: string, path: string): void {
  const template = useSettingsStore.getState().behavior.externalEditor
  void window.pine.externalEditor.open({ template, file: path, line: 1, column: 1 }).then((res) => {
    const d = currentDict()
    if (res.ok) return
    report(
      workspaceId,
      res.error === 'no-editor'
        ? d.editor.externalNoEditor
        : fmt(d.editor.externalFailed, { error: externalEditorError(res) ?? '' }),
    )
  })
}

export interface TreeVisibility {
  hidden: boolean
  toggle: () => void
}

export function FileMenuItems({
  workspaceId,
  path,
  dir = false,
  inPine = false,
  visibility,
}: {
  workspaceId: string
  path: string
  dir?: boolean
  inPine?: boolean
  visibility?: TreeVisibility
}): JSX.Element {
  const d = useDict()
  const agents = useAgentTargets(workspaceId)
  const workDir = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.workDir)
  const relative = workDir ? relativePath(path, workDir) : null
  const copy = (text: string): void => void navigator.clipboard.writeText(text)

  return (
    <>
      {dir ? null : (
        <>
          {inPine ? null : (
            <MenuItem icon={FileIcon} onClick={() => openFileInWorkspace(path)}>
              {d.fileMenu.open}
            </MenuItem>
          )}
          <MenuItem icon={SquareSplitHorizontalIcon} onClick={() => openFileBeside(path)}>
            {d.fileMenu.openBeside}
          </MenuItem>
          <MenuItem icon={CodeIcon} onClick={() => openExternal(workspaceId, path)}>
            {d.fileMenu.openExternal}
          </MenuItem>
        </>
      )}
      <MenuItem icon={SquaresFourIcon} onClick={() => openInNewWorkspace(path, dir)}>
        {d.fileMenu.openWorkspace}
      </MenuItem>
      <MenuItem icon={ArrowSquareOutIcon} onClick={() => openDefault(workspaceId, path)}>
        {d.fileMenu.openDefault}
      </MenuItem>
      <MenuItem
        icon={TerminalWindowIcon}
        onClick={() => openTerminalIn(dir ? path : parentOf(path))}
      >
        {d.fileMenu.openTerminal}
      </MenuItem>
      <MenuItem icon={FolderOpenIcon} onClick={() => void window.pine.openPath.reveal(path)}>
        {d.fileMenu.reveal}
      </MenuItem>
      {visibility ? (
        <MenuItem icon={visibility.hidden ? EyeIcon : EyeSlashIcon} onClick={visibility.toggle}>
          {visibility.hidden ? d.filesView.showInTree : d.filesView.hideInTree}
        </MenuItem>
      ) : null}
      <ContextMenuSeparator />
      <MenuItem icon={CopyIcon} onClick={() => copy(path)}>
        {d.fileMenu.copyPath}
      </MenuItem>
      {relative ? (
        <MenuItem icon={CopyIcon} onClick={() => copy(relative)}>
          {d.fileMenu.copyRelativePath}
        </MenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <MenuSubTrigger icon={PaperPlaneTiltIcon}>{d.fileMenu.sendPath}</MenuSubTrigger>
        <MenuSubContent className="max-w-80">
          {agents.length === 0 ? (
            <MenuItem disabled>{d.fileMenu.noAgents}</MenuItem>
          ) : (
            agents.map((target) => (
              <MenuItem
                key={target.paneId}
                leading={<span className={`dot ${target.state === 'none' ? '' : target.state}`} />}
                onClick={() => sendPath(target, path)}
              >
                {target.title}
              </MenuItem>
            ))
          )}
        </MenuSubContent>
      </ContextMenuSub>
    </>
  )
}

export function FileMenu({
  workspaceId,
  path,
  dir,
  trigger,
  visibility,
}: {
  workspaceId: string
  path: string
  dir?: boolean
  trigger: ReactElement
  visibility?: TreeVisibility
}): JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <MenuContent>
        <FileMenuItems workspaceId={workspaceId} path={path} dir={dir} visibility={visibility} />
      </MenuContent>
    </ContextMenu>
  )
}
