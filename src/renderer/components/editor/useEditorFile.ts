import {
  isRemotePath,
  type RemoteFileError,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { ArchiveEntryProblem, FsTextResult } from '@shared/files/filesApi'
import { type MutableRefObject, useEffect } from 'react'
import { REMOTE_POLL_MS } from '@/lib/files/remoteFileSync'
import { openDocument } from '@/lib/lsp/client'
import { fileFeatureOptions, isLargeModel } from '@/lib/monaco/largeFile'
import { monaco } from '@/lib/monaco/setup'
import { useEditorRevealStore } from '@/stores/files/editorRevealStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import type { DiskBar } from './editorDiskSync'
import {
  createTrackedModel,
  holdShown,
  isDirty,
  markSaved,
  pathOf,
  remoteVersions,
  setDiskBase,
  uriFor,
} from './editorModels'

export type Blocked =
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'unreadable' }
  | { kind: 'archive'; reason: ArchiveEntryProblem }

interface Loaded {
  content: string | null
  version: string | null
  problem: RemoteFileError | null
  blocked: Blocked | null
}

function blockedBy(res: Exclude<FsTextResult, { ok: true }>): Blocked {
  if (res.error === 'binary') return { kind: 'binary' }
  if (res.error === 'too-large') return { kind: 'too-large', size: res.size }
  if (res.error === 'archive') return { kind: 'archive', reason: res.reason }
  return { kind: 'unreadable' }
}

const NOTHING_LOADED: Loaded = { content: null, version: null, problem: null, blocked: null }

async function loadText(filePath: string): Promise<Loaded> {
  if (!isRemotePath(filePath)) {
    const res = await window.ostia.fs.read(filePath)
    if (res.ok) return { ...NOTHING_LOADED, content: res.text, version: res.version }
    if (res.error === 'missing') return NOTHING_LOADED
    return { ...NOTHING_LOADED, blocked: blockedBy(res) }
  }
  const res = await window.ostia.remoteFiles.read(filePath)
  if (res.ok) return { ...NOTHING_LOADED, content: res.content, version: res.version }
  if (res.error === 'not-found') return NOTHING_LOADED
  if (res.error === 'binary') return { ...NOTHING_LOADED, blocked: { kind: 'binary' } }
  return { ...NOTHING_LOADED, problem: res.error }
}

function applyReveal(editor: monaco.editor.IStandaloneCodeEditor, path: string): void {
  const position = useEditorRevealStore.getState().take(path)
  if (!position) return
  editor.setPosition({ lineNumber: position.line, column: position.column })
  editor.revealPositionInCenter({ lineNumber: position.line, column: position.column })
  editor.focus()
}

interface EditorFileParams {
  filePath?: string
  paneId: string
  remote: boolean
  visible: boolean
  diskBar: DiskBar | null
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>
  pathRef: MutableRefObject<string | undefined>
  releaseShownRef: MutableRefObject<() => void>
  checkDiskRef: MutableRefObject<() => Promise<void>>
  visibleRef: MutableRefObject<boolean>
  missedCheckRef: MutableRefObject<boolean>
  setUnsavedPath: (path: string | null) => void
  setRemoteProblem: (problem: RemoteFileError | null) => void
  setBlocked: (blocked: Blocked | null) => void
  setLarge: (large: boolean) => void
  setDiskBar: (bar: DiskBar | null) => void
}

export function useEditorFile({
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
}: EditorFileParams): void {
  useEffect(() => {
    pathRef.current = filePath
    setUnsavedPath(null)
    const editor = editorRef.current
    if (!editor || !filePath) return
    let alive = true
    let releaseDocument = (): void => {}
    const isRemote = isRemotePath(filePath)
    setRemoteProblem(null)
    void loadText(filePath).then(({ content, version, problem, blocked }) => {
      if (!alive || !editorRef.current) return
      setBlocked(blocked)
      if (blocked) {
        editor.setModel(null)
        holdShown(releaseShownRef, null)
        return
      }
      const existing = monaco.editor.getModel(uriFor(filePath))
      if (problem) {
        editor.setModel(existing)
        holdShown(releaseShownRef, existing)
        setRemoteProblem(problem)
        return
      }
      const model = existing ?? createTrackedModel(filePath, content ?? '')
      if (existing && content !== null && !isDirty(existing) && existing.getValue() !== content) {
        existing.setValue(content)
        markSaved(existing, filePath)
      }
      if (!existing || !isDirty(existing)) {
        setDiskBase(model.uri.toString(), content, isRemote ? null : version)
        if (isRemote) remoteVersions.set(model.uri.toString(), version)
      }
      const isLarge = isLargeModel(model)
      setLarge(isLarge)
      editor.updateOptions(fileFeatureOptions(isLarge))
      editor.setModel(model)
      holdShown(releaseShownRef, model)
      applyReveal(editor, filePath)
      if (!isRemote && !isLarge) releaseDocument = openDocument(model, paneId)
    })
    if (!isRemote) void window.ostia.fs.watch(filePath)
    setDiskBar(null)
    return () => {
      alive = false
      releaseDocument()
      if (!isRemote) window.ostia.fs.unwatch(filePath)
    }
  }, [
    filePath,
    paneId,
    pathRef,
    editorRef,
    releaseShownRef,
    setUnsavedPath,
    setRemoteProblem,
    setBlocked,
    setLarge,
    setDiskBar,
  ])

  useEffect(() => {
    const offChanged = window.ostia.fs.onChanged((change) => {
      if (change.path === pathRef.current) void checkDiskRef.current()
    })
    const onFocus = (): void => {
      if (visibleRef.current) void checkDiskRef.current()
      else missedCheckRef.current = true
    }
    window.addEventListener('focus', onFocus)
    return () => {
      offChanged()
      window.removeEventListener('focus', onFocus)
    }
  }, [pathRef, checkDiskRef, visibleRef, missedCheckRef])

  useEffect(() => {
    if (!remote || !visible) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void checkDiskRef.current()
    }, REMOTE_POLL_MS)
    return () => clearInterval(timer)
  }, [remote, visible, checkDiskRef])

  useEffect(() => {
    visibleRef.current = visible
    if (!visible) {
      if (remote) missedCheckRef.current = true
      return
    }
    editorRef.current?.layout()
    if (!missedCheckRef.current) return
    missedCheckRef.current = false
    void checkDiskRef.current()
  }, [visible, remote, visibleRef, missedCheckRef, editorRef, checkDiskRef])

  useEffect(() => {
    if (!filePath) return
    useEditorStatus.getState().setDisk(filePath, diskBar?.kind ?? null)
    return () => useEditorStatus.getState().setDisk(filePath, null)
  }, [filePath, diskBar])

  const pendingReveal = useEditorRevealStore((s) => (filePath ? s.pending[filePath] : undefined))
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!pendingReveal || !editor || !filePath || !model || pathOf(model) !== filePath) return
    applyReveal(editor, filePath)
  }, [pendingReveal, filePath, editorRef])
}
