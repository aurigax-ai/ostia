import type { ReactElement } from 'react'
import { useDict } from '../i18n/useDict'
import { relativePath } from '../lib/fileReference'
import type { PickTarget } from '../lib/pickTargets'
import { canInsertReference, insertPathReference } from '../lib/sendPick'
import { useLayoutStore } from '../stores/layoutStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { usePickTargets } from './PickSendPanel'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './ui/context-menu'

function sendPath(target: PickTarget, path: string): void {
  if (!insertPathReference(target.paneId, path)) return
  if (!target.sameWorkspace) return
  useLayoutStore.getState().focusPane(target.workspaceId, target.paneId)
  requestAnimationFrame(() => focusSurface(target.paneId))
}

export function FileMenu({
  workspaceId,
  path,
  trigger,
}: {
  workspaceId: string
  path: string
  trigger: ReactElement
}): JSX.Element {
  const d = useDict()
  const targets = usePickTargets(workspaceId)
  const workDir = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.workDir)
  const relative = workDir ? relativePath(path, workDir) : null
  const copy = (text: string): void => void navigator.clipboard.writeText(text)

  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={() => copy(path)}>{d.fileMenu.copyPath}</ContextMenuItem>
        {relative ? (
          <ContextMenuItem onClick={() => copy(relative)}>
            {d.fileMenu.copyRelativePath}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>{d.fileMenu.sendPath}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-w-80">
            {targets.length === 0 ? (
              <ContextMenuItem disabled>{d.send.noTargets}</ContextMenuItem>
            ) : (
              targets.map((t) => {
                const ready = canInsertReference(t.paneId)
                return (
                  <ContextMenuItem
                    key={t.paneId}
                    disabled={!ready}
                    onClick={() => sendPath(t, path)}
                  >
                    <span className={`dot ${t.state === 'none' ? '' : t.state}`} aria-hidden />
                    <span className="truncate">
                      {t.sameWorkspace ? t.title : `${t.workspaceName} · ${t.title}`}
                    </span>
                    {ready ? null : <ContextMenuShortcut>{d.fileMenu.busy}</ContextMenuShortcut>}
                  </ContextMenuItem>
                )
              })
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
}
