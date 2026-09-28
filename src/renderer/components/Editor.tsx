import { useEffect, useRef, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { openDocument } from '../lsp/client'
import { monaco } from '../monaco/setup'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useSettingsStore } from '../stores/settingsStore'

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shell',
  zsh: 'shell',
  bash: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  lua: 'lua',
}

function langFor(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return LANG[ext] ?? 'plaintext'
}

const EDITOR_FALLBACK = '"Hack Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

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

export function EditorView({ filePath }: { filePath?: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const d = useDict()
  const pathRef = useRef(filePath)
  const font = useSettingsStore((s) => s.appearance.editor)
  const [binary, setBinary] = useState(false)
  const [unsavedPath, setUnsavedPath] = useState<string | null>(null)

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
      ) : null}
    </>
  )
}
