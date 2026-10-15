import { externalEditorError, openPaneInExternalEditor } from '@/commands/externalEditor'
import { useSelectionSend } from '@/components/agents/SelectionSend'
import { useReducedMotion } from '@/lib/app/motion'
import { fmt, useDict } from '@/lib/app/useDict'
import { usePaneVisible } from '@/lib/attention/workspaceActivity'
import { useArtifactListing } from '@/lib/files/artifacts'
import type { monaco } from '@/lib/monaco/setup'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useOpenWaitsStore } from '@/stores/files/openWaitsStore'
import {
  type RemoteFileError,
  isRemotePath,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { isArchivePath } from '@shared/archives/archivePaths'
import { isInside, isPadPath } from '@shared/artifacts/artifacts'
import { isPreviewPath } from '@shared/artifacts/htmlPreview'
import { useEffect, useRef, useState } from 'react'
import { EditorAlerts } from './EditorAlerts'
import { EditorModes, type OptionViewer } from './EditorModes'
import { LanguageNotice, LargeFileNotice } from './LanguageNotice'
import { type PreviewSelection, isMarkdownPath } from './MarkdownPreview'
import { RemoteFileBar } from './RemoteFileBar'
import type { DiskBar, ReloadFromDisk } from './editorDiskSync'
import { sendSelection, useEditorActions } from './useEditorActions'
import { type Blocked, useEditorFile } from './useEditorFile'
import { useEditorOptions } from './useEditorOptions'
import { useModelText } from './useModelText'
import { useMonacoEditor } from './useMonacoEditor'

export function useExternalEditorAction(paneId: string): {
  open: () => void
  error: string | null
} {
  const d = useDict()
  const [error, setError] = useState<string | null>(null)
  const open = (): void => {
    const pending = openPaneInExternalEditor(paneId)
    if (!pending) return
    pending.then(
      (res) => {
        if (res.ok) setError(null)
        else if (res.error === 'no-editor') setError(d.editor.externalNoEditor)
        else setError(fmt(d.editor.externalFailed, { error: externalEditorError(res) ?? '' }))
      },
      (err: unknown) => setError(fmt(d.editor.externalFailed, { error: String(err) })),
    )
  }
  return { open, error }
}

export function EditorView({
  workspaceId,
  paneId,
  filePath,
  optionViewer,
}: {
  workspaceId: string
  paneId: string
  filePath?: string
  optionViewer?: OptionViewer
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const d = useDict()
  const pathRef = useRef(filePath)
  const font = useSettingsStore((s) => s.appearance.editor)
  const editorSettings = useSettingsStore((s) => s.editor)
  const reducedMotion = useReducedMotion()
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion
  const [blocked, setBlocked] = useState<Blocked | null>(null)
  const [large, setLarge] = useState(false)
  const [remoteProblem, setRemoteProblem] = useState<RemoteFileError | null>(null)
  const remote = isRemotePath(filePath)
  const archived = isArchivePath(filePath)
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)
  const [diskBar, setDiskBar] = useState<DiskBar | null>(null)
  const diskBarRef = useRef<DiskBar | null>(null)
  diskBarRef.current = diskBar
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => {})
  const reloadRef = useRef<ReloadFromDisk>(() => {})
  const checkDiskRef = useRef<() => Promise<void>>(async () => {})
  const releaseShownRef = useRef<() => void>(() => {})
  const [preview, setPreview] = useState(() => useSettingsStore.getState().editor.markdownPreview)
  const markdown = isMarkdownPath(filePath) && !blocked
  const [liveEditor, setLiveEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const previewText = useModelText(liveEditor, markdown && preview)
  const external = useExternalEditorAction(paneId)
  const artifacts = useArtifactListing(workspaceId)
  const pad = isPadPath(artifacts ?? null, filePath)
  const padRef = useRef(pad)
  padRef.current = pad
  const [padFull, setPadFull] = useState(false)
  const padHint = d.artifacts.padHint
  const waitedBy = useOpenWaitsStore((s) => s.byPane[paneId])
  const runnable = isPreviewPath(filePath) && !remote && !blocked
  const inArtifacts = isInside(artifacts?.dir, filePath)
  const [runChoice, setRunChoice] = useState<{ file: string; on: boolean } | null>(null)
  const chosen = runChoice && runChoice.file === filePath ? runChoice.on : null
  const running = runnable && (chosen ?? inArtifacts)
  const visible = usePaneVisible(paneId)
  const visibleRef = useRef(visible)
  const missedCheckRef = useRef(false)
  const openExternalRef = useRef(external.open)
  openExternalRef.current = external.open
  const selectionSend = useSelectionSend(workspaceId, paneId)
  const previewSelectionRef = useRef<PreviewSelection | null>(null)
  const sendSelectionRef = useRef<() => void>(() => {})
  sendSelectionRef.current = () =>
    sendSelection({
      pathRef,
      blocked,
      markdown,
      preview,
      previewSelectionRef,
      selectionSend,
      d,
      editorRef,
    })

  useMonacoEditor({
    hostRef,
    editorRef,
    reducedMotionRef,
    setLiveEditor,
    saveRef,
    reloadRef,
    checkDiskRef,
    diskBarRef,
    setUnsavedPath,
    setRemoteProblem,
    setDiskBar,
    padRef,
    setPadFull,
    visibleRef,
    releaseShownRef,
  })

  useEffect(() => {
    liveEditor?.updateOptions({ readOnly: archived })
  }, [liveEditor, archived])
  useEditorActions({
    d,
    editorRef,
    pathRef,
    workspaceId,
    paneId,
    openExternalRef,
    sendSelectionRef,
  })
  useEditorFile({
    filePath,
    paneId,
    remote,
    visible,
    diskBar,
    editorRef,
    pathRef,
    releaseShownRef,
    checkDiskRef,
    visibleRef,
    missedCheckRef,
    setUnsavedPath,
    setRemoteProblem,
    setBlocked,
    setLarge,
    setDiskBar,
  })
  useEditorOptions({
    editorRef,
    editorSettings,
    pad,
    padHint,
    setPadFull,
    setPreview,
    reducedMotion,
    font,
  })

  return (
    <>
      {filePath && remote ? <RemoteFileBar filePath={filePath} problem={remoteProblem} /> : null}
      {filePath && !blocked && !remote ? (
        large ? (
          <LargeFileNotice />
        ) : (
          <LanguageNotice paneId={paneId} filePath={filePath} />
        )
      ) : null}
      <div
        ref={hostRef}
        className="editor-host"
        style={blocked ? { display: 'none' } : undefined}
      />
      <EditorModes
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={filePath}
        visible={visible}
        markdown={markdown}
        preview={preview}
        setPreview={setPreview}
        previewText={previewText}
        previewSelectionRef={previewSelectionRef}
        sendSelectionRef={sendSelectionRef}
        selectionSend={selectionSend}
        running={running}
        runnable={runnable}
        optionViewer={blocked ? undefined : optionViewer}
        setRunChoice={setRunChoice}
      />
      <EditorAlerts
        workspaceId={workspaceId}
        paneId={paneId}
        blocked={blocked}
        diskBar={diskBar}
        setDiskBar={setDiskBar}
        editorRef={editorRef}
        pathRef={pathRef}
        reloadRef={reloadRef}
        saveRef={saveRef}
        waitedBy={waitedBy}
        padFull={padFull}
        unsavedPath={unsavedPath}
        external={external}
      />
      {selectionSend.panel}
      {selectionSend.status}
    </>
  )
}
