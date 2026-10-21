import { OWN_VIEW } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { isInside } from '@shared/artifacts/artifacts'
import { useCallback, useMemo, useState } from 'react'
import { StatusAction, StatusLine } from '@/components/common/StatusLine'
import { fmt, useDict } from '@/lib/app/useDict'
import { useArtifactListing } from '@/lib/files/artifacts'
import { fileViewKind } from '@/lib/files/fileKinds'
import { chooseViewer, type ViewerOption, viewerOptions } from '@/lib/files/viewerChoice'
import { findPane } from '@/lib/layout/tree'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useArtifactVersionsStore } from '@/stores/files/artifactVersionsStore'
import { useOpenWithStore } from '@/stores/files/openWithStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { VersionView } from './ArtifactVersions'
import { EditorView } from './Editor'
import { FileViewerFrame } from './FileViewerFrame'
import { ImageViewer } from './ImageViewer'
import { isMarkdownPath } from './MarkdownPreview'
import { OpenWithDialog } from './OpenWithDialog'
import { PdfViewer } from './PdfViewer'

const NO_OPTIONS: ViewerOption[] = []

function useViewerChoice(workspaceId: string, paneId: string, filePath: string | undefined) {
  const extensions = useExtensionsStore((s) => s.list)
  const chosen = useLayoutStore((s) => {
    const root = s.byWorkspace[workspaceId]?.root
    return root ? findPane(root, paneId)?.viewType : undefined
  })
  const associations = useSettingsStore((s) => s.files.viewerAssociations)
  const artifacts = useArtifactListing(workspaceId)
  const local = Boolean(filePath) && !isRemotePath(filePath)
  const options = useMemo(
    () => (local ? viewerOptions(filePath, extensions) : NO_OPTIONS),
    [local, filePath, extensions],
  )
  const kind = local ? fileViewKind(filePath) : 'text'
  const choice =
    filePath && local
      ? chooseViewer({
          path: filePath,
          options,
          chosen,
          associations,
          ownView: kind !== 'text' || isMarkdownPath(filePath),
          inArtifacts: isInside(artifacts?.dir, filePath),
        })
      : { viewer: null, unavailable: false }
  return { kind, options, choice, chosen: chosen ?? null }
}

export function FileView({
  workspaceId,
  paneId,
  filePath,
}: {
  workspaceId: string
  paneId: string
  filePath?: string
}): JSX.Element {
  const d = useDict()
  const openWith = useOpenWithStore((s) => s.open)
  const setViewType = useLayoutStore((s) => s.setViewType)
  const locale = useSettingsStore((s) => s.locale)
  const versioned = useArtifactVersionsStore((s) =>
    Boolean(filePath && s.byPane[paneId]?.path === filePath),
  )
  const { kind, options, choice } = useViewerChoice(workspaceId, paneId, filePath)
  const [failed, setFailed] = useState<{ path: string; viewType: string } | null>(null)
  const chosenViewer = choice.viewer
  const failedHere =
    chosenViewer !== null &&
    failed !== null &&
    failed.path === filePath &&
    failed.viewType === chosenViewer.viewType
  const viewer = failedHere ? null : chosenViewer
  const viewerOnly = Boolean(
    filePath && !viewer && (versioned || kind === 'image' || kind === 'pdf'),
  )
  useSurfaceFocus(viewerOnly ? paneId : undefined, null)
  const onFailed = useCallback(() => {
    if (filePath && chosenViewer) setFailed({ path: filePath, viewType: chosenViewer.viewType })
  }, [filePath, chosenViewer])

  const note = choice.unavailable
    ? d.viewer.viewerUnavailable
    : failedHere && chosenViewer
      ? fmt(d.viewer.viewerFailed, { name: chosenViewer.displayName })
      : null

  let body: JSX.Element
  if (filePath && versioned) {
    body = <VersionView workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
  } else if (filePath && viewer) {
    body = (
      <FileViewerFrame
        key={`${filePath}\n${viewer.viewType}\n${locale}`}
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={filePath}
        viewer={viewer}
        onFailed={onFailed}
      />
    )
  } else if (filePath && kind === 'image') {
    body = (
      <ImageViewer key={filePath} workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
    )
  } else if (filePath && kind === 'pdf') {
    body = (
      <PdfViewer key={filePath} workspaceId={workspaceId} paneId={paneId} filePath={filePath} />
    )
  } else {
    const option = options.find((candidate) => candidate.priority === 'option')
    body = (
      <EditorView
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={filePath}
        optionViewer={
          option
            ? {
                name: option.displayName,
                show: () => setViewType(workspaceId, paneId, option.viewType),
              }
            : undefined
        }
      />
    )
  }

  return (
    <div className="flex size-full flex-col">
      {note ? (
        <StatusLine
          tone="warn"
          actions={
            options.length > 0 ? (
              <StatusAction onClick={() => openWith(paneId)}>{d.viewer.openWith}</StatusAction>
            ) : null
          }
        >
          {note}
        </StatusLine>
      ) : null}
      <div className="relative min-h-0 flex-1">{body}</div>
      {filePath && options.length > 0 ? (
        <OpenWithDialog
          workspaceId={workspaceId}
          paneId={paneId}
          filePath={filePath}
          options={options}
          current={viewer?.viewType ?? OWN_VIEW}
          ownLabel={kind === 'text' ? d.viewer.ownText : d.viewer.ownView}
        />
      ) : null}
    </div>
  )
}
