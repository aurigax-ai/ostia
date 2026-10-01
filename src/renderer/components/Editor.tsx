import { cn } from '@/lib/utils'
import { CodeIcon, EyeIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { AUTO_SAVE_DELAY_MS, type EditorSettings } from '@shared/browserEditorSettings'
import { useEffect, useRef, useState } from 'react'
import { externalEditorError, openPaneInExternalEditor } from '../commands/externalEditor'
import { fmt, useDict } from '../i18n/useDict'
import { changedLines, minimalLineEdit } from '../lib/diskReload'
import { registerEditorPosition } from '../lib/editorPositions'
import { createAutoSave, saveFormatted } from '../lib/editorSave'
import { lineReference } from '../lib/fileReference'
import { useReducedMotion } from '../lib/motion'
import { registerSelectionSender } from '../lib/selectionSenders'
import { codeFontStack } from '../lib/uiFonts'
import { attachWheelZoom } from '../lib/wheelZoom'
import { documentSaved, openDocument } from '../lsp/client'
import { useAskSelectionAction, useAssistCompletionsAction } from '../monaco/assistAction'
import { langFor } from '../monaco/language'
import { monaco } from '../monaco/setup'
import { initialMonacoTheme, useMonacoTheme } from '../monaco/useMonacoTheme'
import { isMac } from '../platform'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { MarkdownPreview, type PreviewSelection, isMarkdownPath } from './MarkdownPreview'
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

const BINARY_SNIFF_BYTES = 8192

export function isBinary(content: string): boolean {
  return content.slice(0, BINARY_SNIFF_BYTES).includes('\0')
}

const savedVersions = new Map<string, number>()
const diskBase = new Map<string, string | null>()
const RELOAD_HIGHLIGHT_MS = 2000

type DiskBar =
  | { kind: 'changed'; disk: string }
  | { kind: 'conflict'; disk: string }
  | { kind: 'deleted' }

function isDirty(model: monaco.editor.ITextModel): boolean {
  return savedVersions.get(model.uri.toString()) !== model.getAlternativeVersionId()
}

function markSaved(model: monaco.editor.ITextModel, filePath: string): void {
  savedVersions.set(model.uri.toString(), model.getAlternativeVersionId())
  useEditorStatus.getState().setDirty(filePath, false)
}

function createTrackedModel(filePath: string, content: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(content, langFor(filePath), monaco.Uri.file(filePath))
  markSaved(model, filePath)
  model.onDidChangeContent(() => useEditorStatus.getState().setDirty(filePath, isDirty(model)))
  model.onWillDispose(() => {
    savedVersions.delete(model.uri.toString())
    useEditorStatus.getState().setDirty(filePath, false)
  })
  return model
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
  const [binary, setBinary] = useState(false)
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)
  const [diskBar, setDiskBar] = useState<DiskBar | null>(null)
  const diskBarRef = useRef<DiskBar | null>(null)
  diskBarRef.current = diskBar
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => {})
  const reloadRef = useRef<(model: monaco.editor.ITextModel, text: string) => void>(() => {})
  const checkDiskRef = useRef<() => Promise<void>>(async () => {})
  const [preview, setPreview] = useState(false)
  const markdown = isMarkdownPath(filePath) && !binary
  const previewText = useModelText(editorRef, markdown && preview)
  const external = useExternalEditorAction(paneId)
  useMonacoTheme()
  const openExternalRef = useRef(external.open)
  openExternalRef.current = external.open
  const selectionSend = useSelectionSend(workspaceId, paneId)
  const previewSelectionRef = useRef<PreviewSelection | null>(null)
  const sendSelectionRef = useRef<() => void>(() => {})
  sendSelectionRef.current = () => {
    const file = pathRef.current
    if (!file || binary) return
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
    const editor = monaco.editor.create(host, {
      theme: initialMonacoTheme(),
      automaticLayout: true,
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
      inlineSuggest: { enabled: true },
    })
    editorRef.current = editor

    const save = async (force = false): Promise<void> => {
      const model = editor.getModel()
      if (!model) return
      const fp = model.uri.path
      const key = model.uri.toString()
      if (!force) {
        const onDisk = await window.pine.fs.read(fp)
        if (onDisk !== null && diskBase.has(key) && onDisk !== diskBase.get(key)) {
          setDiskBar({ kind: 'conflict', disk: onDisk })
          return
        }
      }
      let version = model.getAlternativeVersionId()
      const ok = await saveFormatted({
        formatOnSave: useSettingsStore.getState().editor.formatOnSave,
        format: async () => editor.getAction('editor.action.formatDocument')?.run(),
        write: () => {
          version = model.getAlternativeVersionId()
          const text = model.getValue()
          diskBase.set(key, text)
          return window.pine.fs.write(fp, text)
        },
      }).catch(() => false)
      if (!ok) {
        setUnsavedPath(fp)
        return
      }
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

    const reloadFrom = (model: monaco.editor.ITextModel, text: string): void => {
      const changed = changedLines(model.getValue(), text)
      const edit = minimalLineEdit(model.getValue(), text)
      if (edit) {
        const view = editor.saveViewState()
        editor.pushUndoStop()
        model.pushEditOperations([], [edit], () => null)
        editor.pushUndoStop()
        editor.restoreViewState(view)
      }
      diskBase.set(model.uri.toString(), text)
      markSaved(model, model.uri.path)
      showChanged(changed)
    }
    reloadRef.current = reloadFrom

    let checking: Promise<void> | null = null
    let again = false
    const checkDisk = async (): Promise<void> => {
      const model = editor.getModel()
      if (!model) return
      const key = model.uri.toString()
      const onDisk = await window.pine.fs.read(model.uri.path)
      if (editor.getModel() !== model) return
      if (onDisk === diskBase.get(key)) return
      if (onDisk === null) {
        diskBase.set(key, null)
        setDiskBar({ kind: 'deleted' })
        return
      }
      if (!isDirty(model)) {
        reloadFrom(model, onDisk)
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
    const contentSub = editor.onDidChangeModelContent(() => {
      if (useSettingsStore.getState().editor.autoSave === 'afterDelay') autoSave.schedule()
    })
    const blurSub = editor.onDidBlurEditorText(() => saveIfDirty('onFocusChange'))

    const detachWheelZoom = attachWheelZoom(host, 'editor', isMac)

    return () => {
      clearTimeout(highlightTimer)
      autoSave.cancel()
      contentSub.dispose()
      blurSub.dispose()
      detachWheelZoom()
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  const openExternalLabel = d.editor.openExternal
  const sendSelectionLabel = d.viewer.sendSelection
  const copyLinesLabel = d.fileMenu.copyLines
  useAssistCompletionsAction(editorRef)
  useAskSelectionAction(editorRef, pathRef)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const unregister = registerEditorPosition(paneId, () => {
      const file = pathRef.current
      const pos = editor.getPosition()
      return file ? { file, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 } : null
    })
    const action = editor.addAction({
      id: 'pine.openExternal',
      label: openExternalLabel,
      contextMenuGroupId: 'navigation',
      run: () => openExternalRef.current(),
    })
    const sendAction = editor.addAction({
      id: 'pine.sendSelection',
      label: sendSelectionLabel,
      contextMenuGroupId: 'navigation',
      precondition: 'editorHasSelection',
      run: () => sendSelectionRef.current(),
    })
    const copyLinesAction = editor.addAction({
      id: 'pine.copyPathAndLines',
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
    window.pine.fs.read(filePath).then((content) => {
      if (!alive || !editorRef.current) return
      if (content !== null && isBinary(content)) {
        editor.setModel(null)
        setBinary(true)
        return
      }
      setBinary(false)
      const existing = monaco.editor.getModel(monaco.Uri.file(filePath))
      const model = existing ?? createTrackedModel(filePath, content ?? '')
      if (existing && content !== null && !isDirty(existing) && existing.getValue() !== content) {
        existing.setValue(content)
        markSaved(existing, filePath)
      }
      if (!existing || !isDirty(existing)) diskBase.set(model.uri.toString(), content)
      editor.setModel(model)
      applyReveal(editor, filePath)
      releaseDocument = openDocument(model, paneId)
    })
    void window.pine.fs.watch(filePath)
    setDiskBar(null)
    return () => {
      alive = false
      releaseDocument()
      window.pine.fs.unwatch(filePath)
    }
  }, [filePath, paneId])

  useEffect(() => {
    const offChanged = window.pine.fs.onChanged((change) => {
      if (change.path === pathRef.current) void checkDiskRef.current()
    })
    const onFocus = (): void => {
      void checkDiskRef.current()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      offChanged()
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!filePath) return
    useEditorStatus.getState().setDisk(filePath, diskBar?.kind ?? null)
    return () => useEditorStatus.getState().setDisk(filePath, null)
  }, [filePath, diskBar])

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
    if (!pendingReveal || !editor || !filePath || model?.uri.path !== filePath) return
    applyReveal(editor, filePath)
  }, [pendingReveal, filePath])

  useEffect(() => {
    editorRef.current?.updateOptions(behaviorOptions(editorSettings))
  }, [editorSettings])

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
      <div ref={hostRef} className="editor-host" style={binary ? { display: 'none' } : undefined} />
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
      {markdown ? (
        <IconButton
          className="editor-mode"
          icon={preview ? CodeIcon : EyeIcon}
          label={preview ? d.editor.editSource : d.editor.preview}
          hintSide="left"
          onClick={() => setPreview((p) => !p)}
        />
      ) : null}
      {binary ? (
        <div className="pane-body editor-binary">
          <span className="ghost">{d.editor.binary}</span>
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
                <Button variant="outline" size="xs" onClick={() => compareWithDisk(diskBar.disk)}>
                  {d.editor.diskCompare}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const model = editorRef.current?.getModel()
                    if (model) reloadRef.current(model, diskBar.disk)
                    setDiskBar(null)
                  }}
                >
                  {d.editor.diskReload}
                </Button>
                <Button
                  size="xs"
                  onClick={() => {
                    const model = editorRef.current?.getModel()
                    if (model) diskBase.set(model.uri.toString(), diskBar.disk)
                    setDiskBar(null)
                  }}
                >
                  {d.editor.diskKeepMine}
                </Button>
              </>
            ) : diskBar.kind === 'conflict' ? (
              <>
                <Button variant="outline" size="xs" onClick={() => compareWithDisk(diskBar.disk)}>
                  {d.editor.diskCompare}
                </Button>
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
      {unsavedPath ? (
        <Alert className={cn(ATTENTION_ALERT, 'editor-save-error')}>
          {fmt(d.editor.saveError, { path: unsavedPath })}
        </Alert>
      ) : external.error ? (
        <Alert className={cn(ATTENTION_ALERT, 'editor-save-error')}>{external.error}</Alert>
      ) : null}
      {selectionSend.panel}
      {selectionSend.status}
    </>
  )
}

function useModelText(
  editorRef: React.RefObject<monaco.editor.IStandaloneCodeEditor | null>,
  enabled: boolean,
): string {
  const [text, setText] = useState('')
  useEffect(() => {
    const editor = editorRef.current
    if (!enabled || !editor) return
    let content: monaco.IDisposable | undefined
    const follow = (): void => {
      content?.dispose()
      const model = editor.getModel()
      setText(model?.getValue() ?? '')
      content = model?.onDidChangeContent(() => setText(model.getValue()))
    }
    follow()
    const swap = editor.onDidChangeModel(follow)
    return () => {
      swap.dispose()
      content?.dispose()
    }
  }, [editorRef, enabled])
  return text
}
