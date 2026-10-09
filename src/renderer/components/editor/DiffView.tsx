import { ATTENTION_ALERT } from '@/components/agents/attentionStyles'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { Alert } from '@/components/ui/alert'
import { useDict } from '@/i18n/useDict'
import { registerEditorPosition } from '@/lib/files/editorPositions'
import { codeFontStack } from '@/lib/theme/uiFonts'
import { cn } from '@/lib/utils'
import { langFor } from '@/monaco/language'
import { monaco } from '@/monaco/setup'
import { ensureMonacoTheme } from '@/monaco/useMonacoTheme'
import { useDiffStore } from '@/stores/diffStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { ArrowSquareOutIcon, ColumnsIcon, RowsIcon } from '@phosphor-icons/react'
import { DIFF_TEXT_MAX } from '@shared/extensions'
import { useEffect, useRef, useState } from 'react'
import { useExternalEditorAction } from './Editor'

const DIFF_COMPUTATION_MS = 2000
const MB = 1024 * 1024

export function DiffView({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  const content = useDiffStore((s) => s.byPane[paneId])
  const font = useSettingsStore((s) => s.appearance.editor)
  const hostRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const pathRef = useRef(content?.path)
  pathRef.current = content?.path
  const [inline, setInline] = useState(
    () => useSettingsStore.getState().editor.diffLayout === 'inline',
  )
  const external = useExternalEditorAction(paneId)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = useSettingsStore.getState().appearance.editor
    ensureMonacoTheme()
    const diff = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      hideUnchangedRegions: { enabled: true },
      maxComputationTime: DIFF_COMPUTATION_MS,
      maxFileSize: DIFF_TEXT_MAX / MB,
      fontFamily: codeFontStack(initial.family),
      fontSize: initial.size,
      fontWeight: String(initial.weight),
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
      if (diffRef.current === diff) diff.setModel(null)
      original.dispose()
      modified.dispose()
    }
  }, [content])

  useEffect(() => {
    diffRef.current?.updateOptions({ renderSideBySide: !inline })
  }, [inline])

  useEffect(() => {
    diffRef.current?.updateOptions({
      fontFamily: codeFontStack(font.family),
      fontSize: font.size,
      fontWeight: String(font.weight),
    })
  }, [font.family, font.size, font.weight])

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
            label={d.fileMenu.openExternal}
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
