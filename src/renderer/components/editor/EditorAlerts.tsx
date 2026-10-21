import { DIFF_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  isRemotePath,
  parseRemotePath,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { FileDashedIcon } from '@phosphor-icons/react'
import { PAD_MAX_BYTES } from '@shared/artifacts/artifacts'
import type { MutableRefObject } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusAction, StatusLine, useDismissed } from '@/components/common/StatusLine'
import { formatBytes } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { archiveProblemText } from '@/lib/files/archiveProblems'
import { baseName } from '@/lib/files/fileTree'
import { langFor } from '@/lib/monaco/language'
import type { monaco } from '@/lib/monaco/setup'
import { requestClosePane } from '@/lib/workspaces/closeConfirm'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { DiskBar, ReloadFromDisk } from './editorDiskSync'
import { remoteVersions, setDiskBase } from './editorModels'
import { NoPreview } from './NoPreview'
import type { Blocked } from './useEditorFile'

function shownPath(filePath: string): string {
  return parseRemotePath(filePath)?.path ?? filePath
}

interface EditorAlertsProps {
  workspaceId: string
  paneId: string
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

export function EditorBlocked({
  blocked,
  workspaceId,
  filePath,
}: {
  blocked: Blocked
  workspaceId: string
  filePath: string | undefined
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  if (blocked.kind === 'binary' && filePath && !isRemotePath(filePath)) {
    return <NoPreview workspaceId={workspaceId} filePath={filePath} />
  }
  const text =
    blocked.kind === 'binary'
      ? d.editor.noPreview
      : blocked.kind === 'too-large'
        ? fmt(d.editor.tooLarge, { size: formatBytes(blocked.size, locale) })
        : blocked.kind === 'archive'
          ? archiveProblemText(d, blocked.reason)
          : d.editor.unreadable
  return (
    <EmptyState
      variant="surface"
      size="sm"
      className="absolute inset-0"
      icon={<FileDashedIcon aria-hidden />}
      title={text}
    />
  )
}

function DismissibleLine({
  id,
  tone,
  actions,
  testId,
  children,
}: {
  id: string
  tone?: 'muted' | 'warn' | 'error'
  actions?: React.ReactNode
  testId?: string
  children: React.ReactNode
}): JSX.Element | null {
  const [dismissed, dismiss] = useDismissed(id)
  if (dismissed) return null
  return (
    <StatusLine role="alert" tone={tone} data-testid={testId} actions={actions} onDismiss={dismiss}>
      {children}
    </StatusLine>
  )
}

export function EditorAlerts({
  workspaceId,
  paneId,
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

  const compareButton =
    diskBar && diskBar.kind !== 'deleted' && comparable(diskBar.disk) ? (
      <StatusAction onClick={() => compareWithDisk(diskBar.disk)}>
        {d.editor.diskCompare}
      </StatusAction>
    ) : null
  return (
    <>
      {diskBar ? (
        <StatusLine
          role="alert"
          tone="warn"
          data-testid="editor-disk-bar"
          onDismiss={() => setDiskBar(null)}
          actions={
            diskBar.kind === 'changed' ? (
              <>
                {compareButton}
                <StatusAction
                  onClick={() => {
                    const model = editorRef.current?.getModel()
                    if (model) reloadRef.current(model, diskBar.disk, diskBar.version)
                    setDiskBar(null)
                  }}
                >
                  {d.editor.diskReload}
                </StatusAction>
                <StatusAction
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
                </StatusAction>
              </>
            ) : diskBar.kind === 'conflict' ? (
              <>
                {compareButton}
                <StatusAction onClick={() => void saveRef.current(true)}>
                  {d.editor.diskOverwrite}
                </StatusAction>
              </>
            ) : null
          }
        >
          {diskBar.kind === 'changed'
            ? d.editor.diskChanged
            : diskBar.kind === 'conflict'
              ? d.editor.diskConflict
              : d.editor.diskDeleted}
        </StatusLine>
      ) : null}
      {waitedBy ? (
        <DismissibleLine
          id={`waited:${waitedBy.from}:${waitedBy.command}`}
          testId="editor-waited"
          actions={
            <StatusAction onClick={() => void requestClosePane(workspaceId, paneId)}>
              {d.viewer.waitedClose}
            </StatusAction>
          }
        >
          {waitedBy.command
            ? fmt(d.viewer.waitedBy, { command: waitedBy.command, pane: waitedBy.from })
            : fmt(d.viewer.waitedByShell, { pane: waitedBy.from })}
        </DismissibleLine>
      ) : null}
      {padFull ? (
        <DismissibleLine id="pad-full" tone="warn" testId="pad-full">
          {fmt(d.artifacts.padFull, { limit: PAD_MAX_BYTES / 1024 })}
        </DismissibleLine>
      ) : null}
      {unsavedPath ? (
        <DismissibleLine id={`save:${unsavedPath}`} tone="error">
          {fmt(d.editor.saveError, { path: shownPath(unsavedPath) })}
        </DismissibleLine>
      ) : external.error ? (
        <DismissibleLine id={`save:${external.error}`} tone="error">
          {external.error}
        </DismissibleLine>
      ) : null}
    </>
  )
}
