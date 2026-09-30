import { cn } from '@/lib/utils'
import { CodeIcon, EyeIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { AUTO_SAVE_DELAY_MS, type EditorSettings } from '@shared/browserEditorSettings'
import { useEffect, useRef, useState } from 'react'
import { externalEditorError, openPaneInExternalEditor } from '../commands/externalEditor'
import { fmt, useDict } from '../i18n/useDict'
import { registerEditorPosition } from '../lib/editorPositions'
import { createAutoSave, saveFormatted } from '../lib/editorSave'
import { lineReference } from '../lib/fileReference'
import { registerSelectionSender } from '../lib/selectionSenders'
import { attachWheelZoom } from '../lib/wheelZoom'
import { openDocument } from '../lsp/client'
import { useAssistCompletionsAction } from '../monaco/assistAction'
import { langFor } from '../monaco/language'
import { monaco } from '../monaco/setup'
import { initialMonacoTheme, useMonacoTheme } from '../monaco/useMonacoTheme'
import { isMac } from '../platform'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { MarkdownPreview, type PreviewSelection, isMarkdownPath } from './MarkdownPreview'
import { useSelectionSend } from './SelectionSend'
import { ATTENTION_ALERT } from './attentionStyles'
import { Alert } from './ui/alert'

export const EDITOR_FALLBACK =
  '"Hack Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

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
  const [binary, setBinary] = useState(false)
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)
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
      fontFamily: `"${initial.family}", ${EDITOR_FALLBACK}`,
      fontSize: initial.size,
      fontWeight: String(initial.weight),
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      ...behaviorOptions(useSettingsStore.getState().editor),
      renderWhitespace: 'selection',
      padding: { top: 8 },
      inlineSuggest: { enabled: true },
    })
    editorRef.current = editor

    const save = async (): Promise<void> => {
      const model = editor.getModel()
      if (!model) return
      const fp = model.uri.path
      let version = model.getAlternativeVersionId()
      const ok = await saveFormatted({
        formatOnSave: useSettingsStore.getState().editor.formatOnSave,
        format: async () => editor.getAction('editor.action.formatDocument')?.run(),
        write: () => {
          version = model.getAlternativeVersionId()
          return window.pine.fs.write(fp, model.getValue())
        },
      }).catch(() => false)
      if (!ok) {
        setUnsavedPath(fp)
        return
      }
      savedVersions.set(model.uri.toString(), version)
      useEditorStatus.getState().setDirty(fp, isDirty(model))
      setUnsavedPath(null)
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())

    const saveIfDirty = (mode: EditorSettings['autoSave']): void => {
      const model = editor.getModel()
      if (useSettingsStore.getState().editor.autoSave !== mode) return
      if (model && isDirty(model)) void save()
    }
    const autoSave = createAutoSave(() => saveIfDirty('afterDelay'), AUTO_SAVE_DELAY_MS)
    const contentSub = editor.onDidChangeModelContent(() => {
      if (useSettingsStore.getState().editor.autoSave === 'afterDelay') autoSave.schedule()
    })
    const blurSub = editor.onDidBlurEditorText(() => saveIfDirty('onFocusChange'))

    const detachWheelZoom = attachWheelZoom(host, 'editor', isMac)

    return () => {
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
      editor.setModel(model)
      applyReveal(editor, filePath)
      void openDocument(model, langFor(filePath))
    })
    return () => {
      alive = false
    }
  }, [filePath])

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
    editorRef.current?.updateOptions({
      fontFamily: `"${font.family}", ${EDITOR_FALLBACK}`,
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
          label={d.viewer.sendSelection}
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
          aria-pressed={preview}
          hintSide="left"
          onClick={() => setPreview((p) => !p)}
        />
      ) : null}
      {binary ? (
        <div className="pane-body editor-binary">
          <span className="ghost">{d.editor.binary}</span>
        </div>
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
