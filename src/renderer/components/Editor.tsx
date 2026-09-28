import { useEffect, useRef, useState } from 'react'
import { externalEditorError, openPaneInExternalEditor } from '../commands/externalEditor'
import { fmt, useDict } from '../i18n/useDict'
import { registerEditorPosition } from '../lib/editorPositions'
import { openDocument } from '../lsp/client'
import { langFor } from '../monaco/language'
import { monaco } from '../monaco/setup'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useSettingsStore } from '../stores/settingsStore'

export const EDITOR_FALLBACK =
  '"Hack Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

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

export function EditorView({
  paneId,
  filePath,
}: {
  paneId: string
  filePath?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const d = useDict()
  const pathRef = useRef(filePath)
  const font = useSettingsStore((s) => s.appearance.editor)
  const [binary, setBinary] = useState(false)
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)
  const external = useExternalEditorAction(paneId)
  const openExternalRef = useRef(external.open)
  openExternalRef.current = external.open

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.editor
    const editor = monaco.editor.create(host, {
      theme: 'one-dark-vivid',
      automaticLayout: true,
      fontFamily: `"${initial.family}", ${EDITOR_FALLBACK}`,
      fontSize: initial.size,
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      renderWhitespace: 'selection',
      padding: { top: 8 },
    })
    editorRef.current = editor

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const fp = pathRef.current
      const model = editor.getModel()
      if (!fp || !model) return
      const version = model.getAlternativeVersionId()
      window.pine.fs.write(fp, model.getValue()).then(
        (ok) => {
          if (!ok) {
            setUnsavedPath(fp)
            return
          }
          savedVersions.set(model.uri.toString(), version)
          useEditorStatus.getState().setDirty(fp, isDirty(model))
          setUnsavedPath(null)
        },
        () => setUnsavedPath(fp),
      )
    })

    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  const openExternalLabel = d.editor.openExternal
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
    return () => {
      action.dispose()
      unregister()
    }
  }, [paneId, openExternalLabel])

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
      void openDocument(model, langFor(filePath))
    })
    return () => {
      alive = false
    }
  }, [filePath])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: `"${font.family}", ${EDITOR_FALLBACK}`,
      fontSize: font.size,
    })
  }, [font.family, font.size])

  return (
    <>
      <div ref={hostRef} className="editor-host" style={binary ? { display: 'none' } : undefined} />
      {binary ? (
        <div className="pane-body editor-binary">
          <span className="ghost">{d.editor.binary}</span>
        </div>
      ) : null}
      {unsavedPath ? (
        <div role="alert" className="editor-save-error">
          {fmt(d.editor.saveError, { path: unsavedPath })}
        </div>
      ) : external.error ? (
        <div role="alert" className="editor-save-error">
          {external.error}
        </div>
      ) : null}
    </>
  )
}
