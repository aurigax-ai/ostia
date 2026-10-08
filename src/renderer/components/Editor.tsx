import { cn } from '@/lib/utils'
import { CodeIcon, EyeIcon, PaperPlaneTiltIcon, PlayIcon, TableIcon } from '@phosphor-icons/react'
import {
  PAD_MAX_BYTES,
  PAD_SAVE_DELAY_MS,
  exceedsPad,
  isInside,
  isPadPath,
} from '@shared/artifacts'
import { AUTO_SAVE_DELAY_MS, type EditorSettings } from '@shared/browserEditorSettings'
import { DIFF_TEXT_MAX } from '@shared/extensions'
import { isPreviewPath } from '@shared/htmlPreview'
import { type RemoteFileError, isRemotePath, parseRemotePath } from '@shared/remoteFolders'
import type { FsTextResult } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { externalEditorError, openPaneInExternalEditor } from '../commands/externalEditor'
import { fmt, useDict } from '../i18n/useDict'
import { useArtifactListing } from '../lib/artifacts'
import { findStep, matchChord, runAppChord } from '../lib/chords'
import { csvDelimiter, isCsvPath } from '../lib/csvTable'
import { changedLines, minimalLineEdit } from '../lib/diskReload'
import { registerEditorPosition } from '../lib/editorPositions'
import { createAutoSave, saveFormatted } from '../lib/editorSave'
import { lineReference } from '../lib/fileReference'
import { useReducedMotion } from '../lib/motion'
import {
  REMOTE_POLL_MS,
  type RemoteSaveOutcome,
  checkRemoteText,
  saveRemoteText,
} from '../lib/remoteFileSync'
import { registerSelectionSender } from '../lib/selectionSenders'
import { codeFontStack } from '../lib/uiFonts'
import { attachWheelZoom } from '../lib/wheelZoom'
import { usePaneVisible } from '../lib/workspaceActivity'
import { documentSaved, openDocument } from '../lsp/client'
import { useAskSelectionAction, useAssistCompletionsAction } from '../monaco/assistAction'
import { langFor } from '../monaco/language'
import { fileFeatureOptions, isLargeModel } from '../monaco/largeFile'
import { useLiveEditorSelection } from '../monaco/liveSelection'
import { holdModel } from '../monaco/modelHolds'
import { monaco } from '../monaco/setup'
import { ensureMonacoTheme } from '../monaco/useMonacoTheme'
import { isMac } from '../platform'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { CsvTable } from './CsvTable'
import { HtmlPreview } from './HtmlPreview'
import { IconButton } from './IconButton'
import { LanguageNotice, LargeFileNotice } from './LanguageNotice'
import { MarkdownPreview, type PreviewSelection, isMarkdownPath } from './MarkdownPreview'
import { RemoteFileBar } from './RemoteFileBar'
import { useSelectionSend } from './SelectionSend'
import { ATTENTION_ALERT } from './attentionStyles'
import { Alert } from './ui/alert'
import { Button } from './ui/button'

function behaviorOptions(
  s: EditorSettings,
): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    wordWrap: s.wordWrap,
    lineNumbers: s.lineNumbers,
    tabSize: s.tabSize,
    insertSpaces: s.insertSpaces,
    detectIndentation: false,
  }
}

function findAction(by: 1 | -1 | null): string {
  if (by === null) return 'actions.find'
  return by > 0 ? 'editor.action.nextMatchFindAction' : 'editor.action.previousMatchFindAction'
}

const MB = 1024 * 1024

const savedVersions = new Map<string, number>()
const diskBase = new Map<string, string | null>()
const diskVersions = new Map<string, string>()

function setDiskBase(key: string, text: string | null, version: string | null = null): void {
  diskBase.set(key, text)
  if (version === null) diskVersions.delete(key)
  else diskVersions.set(key, version)
}
async function unchangedOnDisk(key: string, filePath: string): Promise<boolean> {
  const known = diskVersions.get(key)
  return known !== undefined && (await window.ostia.fs.version(filePath)) === known
}

const RELOAD_HIGHLIGHT_MS = 2000

const remoteVersions = new Map<string, string | null>()

type DiskBar =
  | { kind: 'changed'; disk: string; version?: string }
  | { kind: 'conflict'; disk: string }
  | { kind: 'deleted' }

function isDirty(model: monaco.editor.ITextModel): boolean {
  return savedVersions.get(model.uri.toString()) !== model.getAlternativeVersionId()
}

function markSaved(model: monaco.editor.ITextModel, filePath: string): void {
  savedVersions.set(model.uri.toString(), model.getAlternativeVersionId())
  useEditorStatus.getState().setDirty(filePath, false)
}

const modelPaths = new WeakMap<monaco.editor.ITextModel, string>()

function pathOf(model: monaco.editor.ITextModel): string {
  return modelPaths.get(model) ?? model.uri.path
}

function uriFor(filePath: string): monaco.Uri {
  const remote = parseRemotePath(filePath)
  return remote
    ? monaco.Uri.from({ scheme: 'remote', authority: remote.folderId, path: remote.path })
    : monaco.Uri.file(filePath)
}

type Blocked = { kind: 'binary' } | { kind: 'too-large'; size: number } | { kind: 'unreadable' }

interface Loaded {
  content: string | null
  version: string | null
  problem: RemoteFileError | null
  blocked: Blocked | null
}

function blockedBy(res: Exclude<FsTextResult, { ok: true }>): Blocked {
  if (res.error === 'binary') return { kind: 'binary' }
  if (res.error === 'too-large') return { kind: 'too-large', size: res.size }
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

function shownPath(filePath: string): string {
  return parseRemotePath(filePath)?.path ?? filePath
}

function createTrackedModel(filePath: string, content: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(content, langFor(filePath), uriFor(filePath))
  modelPaths.set(model, filePath)
  markSaved(model, filePath)
  model.onDidChangeContent(() => useEditorStatus.getState().setDirty(filePath, isDirty(model)))
  model.onWillDispose(() => {
    savedVersions.delete(model.uri.toString())
    diskBase.delete(model.uri.toString())
    remoteVersions.delete(model.uri.toString())
    diskVersions.delete(model.uri.toString())
    useEditorStatus.getState().setDirty(filePath, false)
  })
  return model
}

function holdShown(held: { current: () => void }, model: monaco.editor.ITextModel | null): void {
  const previous = held.current
  held.current = model ? holdModel(model, isDirty) : () => {}
  previous()
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

function applyReveal(editor: monaco.editor.IStandaloneCodeEditor, path: string): void {
  const position = useEditorRevealStore.getState().take(path)
  if (!position) return
  editor.setPosition({ lineNumber: position.line, column: position.column })
  editor.revealPositionInCenter({ lineNumber: position.line, column: position.column })
  editor.focus()
}

export function EditorView({
  workspaceId,
  paneId,
  filePath,
}: {
  workspaceId: string
  paneId: string
  filePath?: string
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
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)
  const [diskBar, setDiskBar] = useState<DiskBar | null>(null)
  const diskBarRef = useRef<DiskBar | null>(null)
  diskBarRef.current = diskBar
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => {})
  const reloadRef = useRef<
    (model: monaco.editor.ITextModel, text: string, version?: string) => void
  >(() => {})
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
  const runnable = isPreviewPath(filePath) && !remote && !blocked
  const inArtifacts = isInside(artifacts?.dir, filePath)
  const [runChoice, setRunChoice] = useState<{ file: string; on: boolean } | null>(null)
  const chosen = runChoice && runChoice.file === filePath ? runChoice.on : null
  const tabular = isCsvPath(filePath) && !remote && !blocked
  const tabled = tabular && (chosen ?? inArtifacts)
  const tableText = useModelText(liveEditor, tabled)
  const running = runnable && (chosen ?? inArtifacts)
  const visible = usePaneVisible(paneId)
  const visibleRef = useRef(visible)
  const missedCheckRef = useRef(false)
  const openExternalRef = useRef(external.open)
  openExternalRef.current = external.open
  const selectionSend = useSelectionSend(workspaceId, paneId)
  const previewSelectionRef = useRef<PreviewSelection | null>(null)
  const sendSelectionRef = useRef<() => void>(() => {})
  sendSelectionRef.current = () => {
    const file = pathRef.current
    if (!file || blocked) return
    if (markdown && preview) {
      const sel = previewSelectionRef.current
      if (!sel) {
        selectionSend.notify(d.viewer.noSelection)
        return
      }
      selectionSend.open({
        kind: 'text',
        file,
        view: 'preview',
        range: { startLine: sel.startLine, endLine: sel.endLine },
        text: sel.text,
      })
      return
    }
    const editor = editorRef.current
    const model = editor?.getModel()
    const sel = editor?.getSelection()
    if (!model || !sel || sel.isEmpty()) {
      selectionSend.notify(d.viewer.noSelection)
      return
    }
    selectionSend.open({
      kind: 'text',
      file,
      view: 'source',
      range: {
        startLine: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLine: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      text: model.getValueInRange(sel),
    })
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.editor
    ensureMonacoTheme()
    const editor = monaco.editor.create(host, {
      automaticLayout: false,
      fontFamily: codeFontStack(initial.family),
      fontSize: initial.size,
      fontWeight: String(initial.weight),
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: !reducedMotionRef.current,
      ...behaviorOptions(useSettingsStore.getState().editor),
      renderWhitespace: 'selection',
      padding: { top: 8 },
      ...fileFeatureOptions(false),
    })
    editorRef.current = editor
    setLiveEditor(editor)
    const appChordKeys = editor.onKeyDown((e) => {
      const chord = matchChord(e.browserEvent, isMac)
      const findBy = findStep(chord)
      if (chord === 'find' || findBy !== null) {
        e.preventDefault()
        e.stopPropagation()
        void editor.getAction(findAction(findBy))?.run()
        return
      }
      if (runAppChord(e.browserEvent, isMac)) e.stopPropagation()
    })

    const saveRemote = async (
      model: monaco.editor.ITextModel,
      fp: string,
      force: boolean,
    ): Promise<void> => {
      const key = model.uri.toString()
      const attempt: { version: number; outcome: RemoteSaveOutcome | null } = {
        version: model.getAlternativeVersionId(),
        outcome: null,
      }
      await saveFormatted({
        formatOnSave: useSettingsStore.getState().editor.formatOnSave,
        format: async () => editor.getAction('editor.action.formatDocument')?.run(),
        write: async () => {
          attempt.version = model.getAlternativeVersionId()
          attempt.outcome = await saveRemoteText(
            window.ostia.remoteFiles,
            fp,
            model.getValue(),
            remoteVersions.get(key) ?? null,
            force,
          )
          return attempt.outcome.kind === 'saved'
        },
      }).catch(() => false)
      const { outcome } = attempt
      if (outcome?.kind === 'saved') {
        remoteVersions.set(key, outcome.version)
        savedVersions.set(key, attempt.version)
        useEditorStatus.getState().setDirty(fp, isDirty(model))
        setUnsavedPath(null)
        setRemoteProblem(null)
        setDiskBar(null)
      } else if (outcome?.kind === 'conflict') {
        setDiskBar({ kind: 'conflict', disk: outcome.disk })
      } else if (outcome?.kind === 'deleted') {
        remoteVersions.set(key, null)
        setDiskBar({ kind: 'deleted' })
      } else {
        setUnsavedPath(fp)
      }
    }

    const save = async (force = false): Promise<void> => {
      const model = editor.getModel()
      if (!model) return
      const fp = pathOf(model)
      if (isRemotePath(fp)) {
        await saveRemote(model, fp, force)
        return
      }
      const key = model.uri.toString()
      if (!force && !(await unchangedOnDisk(key, fp))) {
        const res = await window.ostia.fs.read(fp)
        if (!res.ok && res.error !== 'missing') {
          setUnsavedPath(fp)
          return
        }
        if (res.ok && diskBase.has(key) && res.text !== diskBase.get(key)) {
          setDiskBar({ kind: 'conflict', disk: res.text })
          return
        }
      }
      let version = model.getAlternativeVersionId()
      let text = ''
      const ok = await saveFormatted({
        formatOnSave: useSettingsStore.getState().editor.formatOnSave,
        format: async () => editor.getAction('editor.action.formatDocument')?.run(),
        write: () => {
          version = model.getAlternativeVersionId()
          text = model.getValue()
          setDiskBase(key, text)
          return window.ostia.fs.write(fp, text)
        },
      }).catch(() => false)
      if (!ok) {
        setUnsavedPath(fp)
        return
      }
      const written = await window.ostia.fs.version(fp)
      if (written !== null && diskBase.get(key) === text) diskVersions.set(key, written)
      savedVersions.set(model.uri.toString(), version)
      documentSaved(model)
      useEditorStatus.getState().setDirty(fp, isDirty(model))
      setUnsavedPath(null)
      setDiskBar(null)
    }
    saveRef.current = save

    let highlight: { clear: () => void } | null = null
    let highlightTimer: ReturnType<typeof setTimeout> | undefined
    const showChanged = (lines: { start: number; end: number } | null): void => {
      highlight?.clear()
      clearTimeout(highlightTimer)
      if (!lines) return
      const className = reducedMotionRef.current
        ? 'editor-reload-highlight editor-reload-highlight-static'
        : 'editor-reload-highlight'
      highlight = editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: lines.start,
            startColumn: 1,
            endLineNumber: lines.end,
            endColumn: 1,
          },
          options: { isWholeLine: true, className },
        },
      ])
      highlightTimer = setTimeout(() => {
        highlight?.clear()
        highlight = null
      }, RELOAD_HIGHLIGHT_MS)
    }

    const reloadFrom = (model: monaco.editor.ITextModel, text: string, version?: string): void => {
      const changed = changedLines(model.getValue(), text)
      const edit = minimalLineEdit(model.getValue(), text)
      if (edit) {
        const view = editor.saveViewState()
        editor.pushUndoStop()
        model.pushEditOperations([], [edit], () => null)
        editor.pushUndoStop()
        editor.restoreViewState(view)
      }
      setDiskBase(model.uri.toString(), text)
      if (version !== undefined) remoteVersions.set(model.uri.toString(), version)
      markSaved(model, pathOf(model))
      showChanged(changed)
    }
    reloadRef.current = reloadFrom

    let checking: Promise<void> | null = null
    let again = false
    const checkRemote = async (model: monaco.editor.ITextModel, fp: string): Promise<void> => {
      const key = model.uri.toString()
      if (!remoteVersions.has(key)) return
      const outcome = await checkRemoteText(
        window.ostia.remoteFiles,
        fp,
        remoteVersions.get(key) ?? null,
      )
      if (editor.getModel() !== model) return
      if (outcome.kind === 'deleted') {
        remoteVersions.set(key, null)
        setDiskBar({ kind: 'deleted' })
      } else if (outcome.kind === 'changed') {
        if (!isDirty(model)) {
          reloadFrom(model, outcome.disk, outcome.version)
          setDiskBar(null)
          return
        }
        const shown = diskBarRef.current
        if (shown?.kind === 'changed' && shown.version === outcome.version) return
        setDiskBar({ kind: 'changed', disk: outcome.disk, version: outcome.version })
      }
    }

    const checkDisk = async (): Promise<void> => {
      const model = editor.getModel()
      if (!model) return
      if (isRemotePath(pathOf(model))) {
        await checkRemote(model, pathOf(model))
        return
      }
      const key = model.uri.toString()
      const res = await window.ostia.fs.read(pathOf(model))
      if (editor.getModel() !== model) return
      if (!res.ok && res.error !== 'missing') return
      const onDisk = res.ok ? res.text : null
      if (onDisk === diskBase.get(key)) return
      if (onDisk === null) {
        setDiskBase(key, null)
        setDiskBar({ kind: 'deleted' })
        return
      }
      if (!isDirty(model)) {
        reloadFrom(model, onDisk)
        if (res.ok) diskVersions.set(key, res.version)
        setDiskBar(null)
        return
      }
      setDiskBar({ kind: 'changed', disk: onDisk })
    }
    checkDiskRef.current = () => {
      if (checking) {
        again = true
        return checking
      }
      checking = checkDisk().finally(() => {
        checking = null
        if (again) {
          again = false
          void checkDiskRef.current()
        }
      })
      return checking
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())

    const saveIfDirty = (mode: EditorSettings['autoSave']): void => {
      const model = editor.getModel()
      if (useSettingsStore.getState().editor.autoSave !== mode) return
      if (diskBarRef.current) return
      if (model && isDirty(model)) void save()
    }
    const autoSave = createAutoSave(() => saveIfDirty('afterDelay'), AUTO_SAVE_DELAY_MS)
    const padSave = createAutoSave(() => {
      const model = editor.getModel()
      if (padRef.current && !diskBarRef.current && model && isDirty(model)) void save()
    }, PAD_SAVE_DELAY_MS)
    const measurePad = (): void =>
      setPadFull(padRef.current && exceedsPad(editor.getModel()?.getValue() ?? ''))
    const contentSub = editor.onDidChangeModelContent(() => {
      if (useSettingsStore.getState().editor.autoSave === 'afterDelay') autoSave.schedule()
      if (!padRef.current) return
      padSave.schedule()
      measurePad()
    })
    const modelSub = editor.onDidChangeModel(measurePad)
    const blurSub = editor.onDidBlurEditorText(() => saveIfDirty('onFocusChange'))

    const detachWheelZoom = attachWheelZoom(host, 'editor', isMac)
    const resize = new ResizeObserver(() => {
      if (visibleRef.current) editor.layout()
    })
    resize.observe(host)

    return () => {
      resize.disconnect()
      clearTimeout(highlightTimer)
      autoSave.cancel()
      padSave.cancel()
      appChordKeys.dispose()
      contentSub.dispose()
      modelSub.dispose()
      blurSub.dispose()
      detachWheelZoom()
      editor.dispose()
      releaseShownRef.current()
      releaseShownRef.current = () => {}
      editorRef.current = null
      setLiveEditor(null)
    }
  }, [])

  const openExternalLabel = d.editor.openExternal
  const sendSelectionLabel = d.viewer.sendSelection
  const copyLinesLabel = d.fileMenu.copyLines
  useAssistCompletionsAction(editorRef)
  useAskSelectionAction(editorRef, pathRef)
  useLiveEditorSelection(editorRef, pathRef, workspaceId, paneId)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const unregister = registerEditorPosition(paneId, () => {
      const file = pathRef.current
      const pos = editor.getPosition()
      return file ? { file, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 } : null
    })
    const action = editor.addAction({
      id: 'ostia.openExternal',
      label: openExternalLabel,
      contextMenuGroupId: 'navigation',
      run: () => openExternalRef.current(),
    })
    const sendAction = editor.addAction({
      id: 'ostia.sendSelection',
      label: sendSelectionLabel,
      contextMenuGroupId: 'navigation',
      precondition: 'editorHasSelection',
      run: () => sendSelectionRef.current(),
    })
    const copyLinesAction = editor.addAction({
      id: 'ostia.copyPathAndLines',
      label: copyLinesLabel,
      contextMenuGroupId: '9_cutcopypaste',
      run: () => {
        const file = pathRef.current
        const sel = editor.getSelection()
        if (!file || !sel) return
        const endLine =
          sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
            ? sel.endLineNumber - 1
            : sel.endLineNumber
        void navigator.clipboard.writeText(lineReference(file, sel.startLineNumber, endLine))
      },
    })
    const unregisterSender = registerSelectionSender(paneId, () => sendSelectionRef.current())
    return () => {
      action.dispose()
      sendAction.dispose()
      copyLinesAction.dispose()
      unregisterSender()
      unregister()
    }
  }, [paneId, openExternalLabel, sendSelectionLabel, copyLinesLabel])

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
  }, [filePath, paneId])

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
  }, [])

  useEffect(() => {
    if (!remote || !visible) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void checkDiskRef.current()
    }, REMOTE_POLL_MS)
    return () => clearInterval(timer)
  }, [remote, visible])

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
  }, [visible, remote])

  useEffect(() => {
    if (!filePath) return
    useEditorStatus.getState().setDisk(filePath, diskBar?.kind ?? null)
    return () => useEditorStatus.getState().setDisk(filePath, null)
  }, [filePath, diskBar])

  const comparable = (disk: string): boolean =>
    disk.length <= DIFF_TEXT_MAX &&
    (editorRef.current?.getModel()?.getValueLength() ?? 0) <= DIFF_TEXT_MAX

  const compareWithDisk = (disk: string): void => {
    const model = editorRef.current?.getModel()
    const file = pathRef.current
    if (!model || !file) return
    useLayoutStore.getState().openDiff(workspaceId, {
      title: fmt(d.editor.diskCompareTitle, { name: file.split('/').pop() ?? file }),
      original: disk,
      modified: model.getValue(),
      language: langFor(file),
      path: file,
    })
  }

  const pendingReveal = useEditorRevealStore((s) => (filePath ? s.pending[filePath] : undefined))
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!pendingReveal || !editor || !filePath || !model || pathOf(model) !== filePath) return
    applyReveal(editor, filePath)
  }, [pendingReveal, filePath])

  useEffect(() => {
    editorRef.current?.updateOptions(behaviorOptions(editorSettings))
  }, [editorSettings])

  useEffect(() => {
    const editor = editorRef.current
    if (!pad || !editor) {
      setPadFull(false)
      return
    }
    setPreview(false)
    setPadFull(exceedsPad(editor.getModel()?.getValue() ?? ''))
    editor.updateOptions({ placeholder: padHint })
    return () => editor.updateOptions({ placeholder: '' })
  }, [pad, padHint])

  useEffect(() => {
    editorRef.current?.updateOptions({ smoothScrolling: !reducedMotion })
  }, [reducedMotion])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: codeFontStack(font.family),
      fontSize: font.size,
      fontWeight: String(font.weight),
    })
  }, [font.family, font.size, font.weight])

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
      {markdown && preview ? (
        <MarkdownPreview
          source={previewText}
          onSelectionChange={(sel) => {
            previewSelectionRef.current = sel
          }}
        />
      ) : null}
      {markdown && preview ? (
        <IconButton
          className="editor-send"
          icon={PaperPlaneTiltIcon}
          label={d.viewer.sendPdfSelection}
          hintSide="left"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => sendSelectionRef.current()}
        />
      ) : null}
      {running && filePath ? (
        <HtmlPreview
          key={filePath}
          workspaceId={workspaceId}
          paneId={paneId}
          filePath={filePath}
          visible={visible}
          onSendErrors={(count, text) =>
            selectionSend.open({ kind: 'preview-error', file: filePath, count, text })
          }
        />
      ) : null}
      {tabled && filePath ? (
        <CsvTable source={tableText} delimiter={csvDelimiter(filePath)} />
      ) : null}
      {tabular && filePath ? (
        <IconButton
          className="editor-mode"
          icon={tabled ? CodeIcon : TableIcon}
          label={tabled ? d.viewer.csvSource : d.viewer.csvTable}
          hintSide="left"
          onClick={() => setRunChoice({ file: filePath, on: !tabled })}
        />
      ) : null}
      {runnable && filePath ? (
        <IconButton
          className="editor-mode"
          icon={running ? CodeIcon : PlayIcon}
          label={running ? d.preview.editSource : d.preview.run}
          hintSide="left"
          onClick={() => setRunChoice({ file: filePath, on: !running })}
        />
      ) : null}
      {markdown ? (
        <IconButton
          className="editor-mode"
          icon={preview ? CodeIcon : EyeIcon}
          label={preview ? d.editor.editSource : d.editor.preview}
          hintSide="left"
          onClick={() => setPreview((p) => !p)}
        />
      ) : null}
      {blocked ? (
        <div className="pane-body editor-binary">
          <span className="ghost">
            {blocked.kind === 'binary'
              ? d.editor.binary
              : blocked.kind === 'too-large'
                ? fmt(d.editor.tooLarge, { size: (blocked.size / MB).toFixed(1) })
                : d.editor.unreadable}
          </span>
        </div>
      ) : null}
      {diskBar ? (
        <Alert className={cn(ATTENTION_ALERT, 'editor-disk-bar')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              {diskBar.kind === 'changed'
                ? d.editor.diskChanged
                : diskBar.kind === 'conflict'
                  ? d.editor.diskConflict
                  : d.editor.diskDeleted}
            </span>
            {diskBar.kind === 'changed' ? (
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
            ) : null}
          </div>
        </Alert>
      ) : null}
      {padFull ? (
        <Alert className={cn(ATTENTION_ALERT, 'editor-pad-full')} data-testid="pad-full">
          {fmt(d.artifacts.padFull, { limit: PAD_MAX_BYTES / 1024 })}
        </Alert>
      ) : null}
      {unsavedPath ? (
        <Alert className={cn(ATTENTION_ALERT, 'editor-save-error')}>
          {fmt(d.editor.saveError, { path: shownPath(unsavedPath) })}
        </Alert>
      ) : external.error ? (
        <Alert className={cn(ATTENTION_ALERT, 'editor-save-error')}>{external.error}</Alert>
      ) : null}
      {selectionSend.panel}
      {selectionSend.status}
    </>
  )
}

const PREVIEW_DEBOUNCE_MS = 150

function useModelText(
  editor: monaco.editor.IStandaloneCodeEditor | null,
  enabled: boolean,
): string {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!enabled || !editor) return
    let content: monaco.IDisposable | undefined
    let pending: ReturnType<typeof setTimeout> | undefined
    const follow = (): void => {
      content?.dispose()
      clearTimeout(pending)
      const model = editor.getModel()
      setText(model?.getValue() ?? '')
      content = model?.onDidChangeContent(() => {
        clearTimeout(pending)
        pending = setTimeout(() => setText(model.getValue()), PREVIEW_DEBOUNCE_MS)
      })
    }
    follow()
    const swap = editor.onDidChangeModel(follow)
    return () => {
      swap.dispose()
      content?.dispose()
      clearTimeout(pending)
    }
  }, [editor, enabled])
  return text
}
