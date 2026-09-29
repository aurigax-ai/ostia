import { cn } from '@/lib/utils'
import { ArrowSquareOutIcon, ColumnsIcon, RowsIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { registerEditorPosition } from '../lib/editorPositions'
import { langFor } from '../monaco/language'
import { monaco } from '../monaco/setup'
import { useDiffStore } from '../stores/diffStore'
import { useSettingsStore } from '../stores/settingsStore'
import { EDITOR_FALLBACK, useExternalEditorAction } from './Editor'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { ATTENTION_ALERT } from './attentionStyles'
import { Alert } from './ui/alert'

export function DiffView({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  const content = useDiffStore((s) => s.byPane[paneId])
  const font = useSettingsStore((s) => s.appearance.editor)
  const hostRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const pathRef = useRef(content?.path)
  pathRef.current = content?.path
  const [inline, setInline] = useState(false)
  const external = useExternalEditorAction(paneId)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = useSettingsStore.getState().appearance.editor
    const diff = monaco.editor.createDiffEditor(host, {
      theme: 'one-dark-vivid',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: `"${initial.family}", ${EDITOR_FALLBACK}`,
      fontSize: initial.size,
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8 },
    })
    diffRef.current = diff
    const unregister = registerEditorPosition(paneId, () => {
      const file = pathRef.current
      if (!file) return null
      const pos = diff.getModifiedEditor().getPosition()
      return { file, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 }
    })
    return () => {
      unregister()
      diff.dispose()
      diffRef.current = null
    }
  }, [paneId])

  useEffect(() => {
    const diff = diffRef.current
    if (!diff || !content) return
    const language = content.language ?? (content.path ? langFor(content.path) : 'plaintext')
    const original = monaco.editor.createModel(content.original, language)
    const modified = monaco.editor.createModel(content.modified, language)
    diff.setModel({ original, modified })
    return () => {
      diff.setModel(null)
      original.dispose()
      modified.dispose()
    }
  }, [content])

  useEffect(() => {
    diffRef.current?.updateOptions({ renderSideBySide: !inline })
  }, [inline])

  useEffect(() => {
    diffRef.current?.updateOptions({
      fontFamily: `"${font.family}", ${EDITOR_FALLBACK}`,
      fontSize: font.size,
    })
  }, [font.family, font.size])

  return (
    <div className="diff-surface">
      <div className="diff-toolbar">
        {content?.path ? (
          <Hint label={content.path}>
            <span className="diff-title">{content.path}</span>
          </Hint>
        ) : (
          <span className="diff-title">{content?.title ?? ''}</span>
        )}
        <IconButton
          icon={inline ? ColumnsIcon : RowsIcon}
          label={inline ? d.diff.sideBySide : d.diff.inline}
          onClick={() => setInline((v) => !v)}
        />
        {content?.path ? (
          <IconButton
            icon={ArrowSquareOutIcon}
            label={d.editor.openExternal}
            onClick={external.open}
          />
        ) : null}
      </div>
      <div className="diff-body">
        <div
          ref={hostRef}
          className="editor-host"
          style={content ? undefined : { display: 'none' }}
        />
        {content ? null : (
          <div className="pane-body">
            <span className="ghost">{d.diff.missing}</span>
          </div>
        )}
        {external.error ? (
          <Alert className={cn(ATTENTION_ALERT, 'editor-save-error')}>{external.error}</Alert>
        ) : null}
      </div>
    </div>
  )
}
