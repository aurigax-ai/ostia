import { NoticeBar } from '@/components/common/Notice'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { archiveProblemText } from '@/lib/files/archiveProblems'
import { baseName } from '@/lib/files/fileTree'
import { langFor } from '@/lib/monaco/language'
import type { monaco } from '@/lib/monaco/setup'
import { requestClosePane } from '@/lib/workspaces/closeConfirm'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { DIFF_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { parseRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { PAD_MAX_BYTES } from '@shared/artifacts/artifacts'
import type { MutableRefObject } from 'react'
import type { DiskBar, ReloadFromDisk } from './editorDiskSync'
import { remoteVersions, setDiskBase } from './editorModels'
import type { Blocked } from './useEditorFile'

function shownPath(filePath: string): string {
  return parseRemotePath(filePath)?.path ?? filePath
}

interface EditorAlertsProps {
  workspaceId: string
  paneId: string
  blocked: Blocked | null
  diskBar: DiskBar | null
  setDiskBar: (bar: DiskBar | null) => void
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  pathRef: MutableRefObject<string | undefined>
  reloadRef: MutableRefObject<ReloadFromDisk>
  saveRef: MutableRefObject<(force?: boolean) => Promise<void>>
  waitedBy?: { from: string; command: string | null }
  padFull: boolean
  unsavedPath: string | null
  external: { error: string | null }
}

export function EditorAlerts({
  workspaceId,
  paneId,
  blocked,
  diskBar,
  setDiskBar,
  editorRef,
  pathRef,
  reloadRef,
  saveRef,
  waitedBy,
  padFull,
  unsavedPath,
  external,
}: EditorAlertsProps): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const comparable = (disk: string): boolean =>
    disk.length <= DIFF_TEXT_MAX &&
    (editorRef.current?.getModel()?.getValueLength() ?? 0) <= DIFF_TEXT_MAX

  const compareWithDisk = (disk: string): void => {
    const model = editorRef.current?.getModel()
    const file = pathRef.current
    if (!model || !file) return
    useLayoutStore.getState().openDiff(workspaceId, {
      title: fmt(d.editor.diskCompareTitle, { name: baseName(file) }),
      original: disk,
      modified: model.getValue(),
      language: langFor(file),
      path: file,
    })
  }

  return (
    <>
      {blocked ? (
        <div className="pane-body editor-binary">
          <span className="ghost">
            {blocked.kind === 'binary'
              ? d.editor.binary
              : blocked.kind === 'too-large'
                ? fmt(d.editor.tooLarge, { size: formatBytes(blocked.size, locale) })
                : blocked.kind === 'archive'
                  ? archiveProblemText(d, blocked.reason)
                  : d.editor.unreadable}
          </span>
        </div>
      ) : null}
      {diskBar ? (
        <NoticeBar
          className="editor-disk-bar"
          actions={
            diskBar.kind === 'changed' ? (
              <>
                {comparable(diskBar.disk) ? (
                  <Button variant="outline" size="xs" onClick={() => compareWithDisk(diskBar.disk)}>
                    {d.editor.diskCompare}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const model = editorRef.current?.getModel()
                    if (model) reloadRef.current(model, diskBar.disk, diskBar.version)
                    setDiskBar(null)
                  }}
                >
                  {d.editor.diskReload}
                </Button>
                <Button
                  size="xs"
                  onClick={() => {
                    const model = editorRef.current?.getModel()
                    if (model) {
                      setDiskBase(model.uri.toString(), diskBar.disk)
                      if (diskBar.version !== undefined) {
                        remoteVersions.set(model.uri.toString(), diskBar.version)
                      }
                    }
                    setDiskBar(null)
                  }}
                >
                  {d.editor.diskKeepMine}
                </Button>
              </>
            ) : diskBar.kind === 'conflict' ? (
              <>
                {comparable(diskBar.disk) ? (
                  <Button variant="outline" size="xs" onClick={() => compareWithDisk(diskBar.disk)}>
                    {d.editor.diskCompare}
                  </Button>
                ) : null}
                <Button variant="outline" size="xs" onClick={() => setDiskBar(null)}>
                  {d.editor.diskCancel}
                </Button>
                <Button size="xs" onClick={() => void saveRef.current(true)}>
                  {d.editor.diskOverwrite}
                </Button>
              </>
            ) : null
          }
        >
          {diskBar.kind === 'changed'
            ? d.editor.diskChanged
            : diskBar.kind === 'conflict'
              ? d.editor.diskConflict
              : d.editor.diskDeleted}
        </NoticeBar>
      ) : null}
      {waitedBy ? (
        <NoticeBar
          className="editor-waited"
          data-testid="editor-waited"
          actions={
            <Button
              variant="outline"
              size="xs"
              onClick={() => void requestClosePane(workspaceId, paneId)}
            >
              {d.viewer.waitedClose}
            </Button>
          }
        >
          {waitedBy.command
            ? fmt(d.viewer.waitedBy, { command: waitedBy.command, pane: waitedBy.from })
            : fmt(d.viewer.waitedByShell, { pane: waitedBy.from })}
        </NoticeBar>
      ) : null}
      {padFull ? (
        <NoticeBar className="editor-pad-full" data-testid="pad-full">
          {fmt(d.artifacts.padFull, { limit: PAD_MAX_BYTES / 1024 })}
        </NoticeBar>
      ) : null}
      {unsavedPath ? (
        <NoticeBar tone="error" className="editor-save-error">
          {fmt(d.editor.saveError, { path: shownPath(unsavedPath) })}
        </NoticeBar>
      ) : external.error ? (
        <NoticeBar tone="error" className="editor-save-error">
          {external.error}
        </NoticeBar>
      ) : null}
    </>
  )
}
