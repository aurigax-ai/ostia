import {
  isRemotePath,
  type RemoteFileError,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { isArchivePath } from '@shared/archives/archivePaths'
import { isInside, isPadPath } from '@shared/artifacts/artifacts'
import { isPreviewPath } from '@shared/artifacts/htmlPreview'
import { useEffect, useRef, useState } from 'react'
import { externalEditorError, openPaneInExternalEditor } from '@/commands/externalEditor'
import { useReducedMotion } from '@/lib/app/motion'
import { fmt, useDict } from '@/lib/app/useDict'
import { usePaneVisible } from '@/lib/attention/workspaceActivity'
import { useArtifactListing } from '@/lib/files/artifacts'
import { editorInput } from '@/lib/monaco/editorInput'
import type { monaco } from '@/lib/monaco/setup'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useOpenWaitsStore } from '@/stores/files/openWaitsStore'
import type { DiskBar, ReloadFromDisk } from './editorDiskSync'
import { sendSelection, useEditorActions } from './useEditorActions'
import { type Blocked, useEditorFile } from './useEditorFile'
import { useEditorOptions } from './useEditorOptions'
import { useMonacoEditor } from './useMonacoEditor'

function useRunChoice(filePath: string | undefined, runnable: boolean, inArtifacts: boolean) {
  const [runChoice, setRunChoice] = useState<{ file: string; on: boolean } | null>(null)
  const chosen = runChoice && runChoice.file === filePath ? runChoice.on : null
  const running = runnable && (chosen ?? inArtifacts)
  return { setRunChoice, running }
}

interface EditorViewParams {
  workspaceId: string
  paneId: string
  filePath?: string
}

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

export function useEditorView({ workspaceId, paneId, filePath }: EditorViewParams) {
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
  const [liveEditor, setLiveEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const external = useExternalEditorAction(paneId)
  const artifacts = useArtifactListing(workspaceId)
  const pad = isPadPath(artifacts ?? null, filePath)
  const padRef = useRef(pad)
  padRef.current = pad
  const [padFull, setPadFull] = useState(false)
  const waitedBy = useOpenWaitsStore((s) => s.byPane[paneId])
  const runnable = isPreviewPath(filePath) && !remote && !blocked
  const inArtifacts = isInside(artifacts?.dir, filePath)
  const { setRunChoice, running } = useRunChoice(filePath, runnable, inArtifacts)
  const overlayRef = useRef<HTMLElement | null>(null)
  const overlayUp = running
  useSurfaceFocus(
    paneId,
    blocked ? null : () => (overlayUp ? overlayRef.current : editorInput(editorRef.current)),
  )
  const visible = usePaneVisible(paneId)
  const visibleRef = useRef(visible)
  const missedCheckRef = useRef(false)
  const openExternalRef = useRef(external.open)
  openExternalRef.current = external.open
  const sendSelectionRef = useRef<() => void>(() => {})
  sendSelectionRef.current = () =>
    sendSelection({
      pathRef,
      blocked,
      paneId,
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
    padHint: d.artifacts.padHint,
    setPadFull,
    font,
  })

  return {
    hostRef,
    blocked,
    large,
    remoteProblem,
    visible,
    running,
    runnable,
    overlayRef,
    setRunChoice,
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
  }
}
