import { useEffect, useRef } from 'react'
import { openDocument } from '../lsp/client'
import { monaco } from '../monaco/setup'
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

/**
 * A code editor surface: Monaco (VSCode's editor) with built-in TS/JS IntelliSense and
 * the One Dark Vivid theme. Opens the pane's `filePath`; ⌘S / Ctrl+S writes it back.
 */
export function EditorView({ filePath }: { filePath?: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const pathRef = useRef(filePath)
  const font = useSettingsStore((s) => s.appearance.editor)

  // Create the editor once.
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

    // ⌘S / Ctrl+S → save the current file.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const fp = pathRef.current
      if (fp) void window.pine.fs.write(fp, editor.getValue())
    })

    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  // Load the file when it changes (reuse a model per file URI).
  useEffect(() => {
    pathRef.current = filePath
    const editor = editorRef.current
    if (!editor || !filePath) return
    let alive = true
    window.pine.fs.read(filePath).then((content) => {
      if (!alive || !editorRef.current) return
      const uri = monaco.Uri.file(filePath)
      const existing = monaco.editor.getModel(uri)
      const model = existing ?? monaco.editor.createModel(content ?? '', langFor(filePath), uri)
      if (existing && content !== null) existing.setValue(content)
      editor.setModel(model)
      // Best-effort: attach an external language server if one is installed for this language.
      void openDocument(model, langFor(filePath))
    })
    return () => {
      alive = false
    }
  }, [filePath])

  // Apply editor-font changes live.
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: `"${font.family}", ${EDITOR_FALLBACK}`,
      fontSize: font.size,
    })
  }, [font.family, font.size])

  return <div ref={hostRef} className="editor-host" />
}
