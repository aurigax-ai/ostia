import { DIFF_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  ArrowSquareOutIcon,
  CaretDoubleDownIcon,
  CaretDoubleUpIcon,
  CaretDownIcon,
  CaretUpIcon,
  ColumnsIcon,
  FileTextIcon,
  ParagraphIcon,
  RowsIcon,
} from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { Segmented } from '@/components/common/Segmented'
import { StatusLine, useDismissed } from '@/components/common/StatusLine'
import { useDict } from '@/lib/app/useDict'
import { useElementSize } from '@/lib/app/useElementSize'
import { registerEditorPosition } from '@/lib/files/editorPositions'
import { isInlineDiff } from '@/lib/monaco/diffLayout'
import { editorInput } from '@/lib/monaco/editorInput'
import { langFor } from '@/lib/monaco/language'
import { EDITOR_SCROLLBAR } from '@/lib/monaco/scrollbarOptions'
import { monaco } from '@/lib/monaco/setup'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import type { DiffLayout } from '@/lib/settings/browserEditorSettings'
import { codeFontStack } from '@/lib/theme/uiFonts'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useDiffStore } from '@/stores/files/diffStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useExternalEditorAction } from './useEditorView'

const DIFF_COMPUTATION_MS = 2000
const MB = 1024 * 1024

export function DiffView({
  workspaceId,
  paneId,
}: {
  workspaceId: string
  paneId: string
}): JSX.Element {
  const d = useDict()
  const content = useDiffStore((s) => s.byPane[paneId])
  const font = useSettingsStore((s) => s.appearance.editor)
  const hostRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  useSurfaceFocus(paneId, () => editorInput(diffRef.current?.getModifiedEditor()))
  const pathRef = useRef(content?.path)
  pathRef.current = content?.path
  const layout = useSettingsStore((s) => s.editor.diffLayout)
  const ignoreWhitespace = useSettingsStore((s) => s.editor.diffIgnoreWhitespace)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { width } = useElementSize(bodyRef)
  const inline = isInlineDiff(layout, width)
  const external = useExternalEditorAction(paneId)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = useSettingsStore.getState().appearance.editor
    const initialIgnoreWhitespace = useSettingsStore.getState().editor.diffIgnoreWhitespace
    const diff = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      ignoreTrimWhitespace: initialIgnoreWhitespace,
      hideUnchangedRegions: { enabled: true },
      maxComputationTime: DIFF_COMPUTATION_MS,
      maxFileSize: DIFF_TEXT_MAX / MB,
      fontFamily: codeFontStack(initial.family),
      fontSize: initial.size,
      fontWeight: String(initial.weight),
      fontLigatures: true,
      minimap: { enabled: false },
      scrollbar: EDITOR_SCROLLBAR,
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
    diffRef.current?.updateOptions({ ignoreTrimWhitespace: ignoreWhitespace })
  }, [ignoreWhitespace])

  useEffect(() => {
    diffRef.current?.updateOptions({
      fontFamily: codeFontStack(font.family),
      fontSize: font.size,
      fontWeight: String(font.weight),
    })
  }, [font.family, font.size, font.weight])

  const [errorDismissed, dismissError] = useDismissed(external.error ?? '')
  const choose = (next: DiffLayout): void =>
    useSettingsStore.getState().setEditor({ diffLayout: next })

  return (
    <div className="diff-surface">
      <div className="diff-toolbar">
        <span className="flex-1" />
        <IconButton
          icon={CaretUpIcon}
          label={d.diff.previousChange}
          onClick={() => diffRef.current?.goToDiff('previous')}
        />
        <IconButton
          icon={CaretDownIcon}
          label={d.diff.nextChange}
          onClick={() => diffRef.current?.goToDiff('next')}
        />
        {content?.area ? (
          <>
            <IconButton
              icon={CaretDoubleUpIcon}
              label={d.diff.previousFile}
              onClick={() => void commands.exec('git.openPreviousChange', { paneId })}
            />
            <IconButton
              icon={CaretDoubleDownIcon}
              label={d.diff.nextFile}
              onClick={() => void commands.exec('git.openNextChange', { paneId })}
            />
          </>
        ) : null}
        <IconButton
          icon={ParagraphIcon}
          label={d.diff.ignoreWhitespace}
          aria-pressed={ignoreWhitespace}
          onClick={() =>
            useSettingsStore.getState().setEditor({ diffIgnoreWhitespace: !ignoreWhitespace })
          }
        />
        <Segmented
          iconOnly
          label={d.editorSettings.diffLayout}
          value={inline ? 'inline' : 'sideBySide'}
          options={[
            { value: 'sideBySide', label: d.diff.sideBySide, icon: ColumnsIcon },
            { value: 'inline', label: d.diff.inline, icon: RowsIcon },
          ]}
          onChange={choose}
        />
        {content?.path ? (
          <>
            <IconButton
              icon={FileTextIcon}
              label={d.diff.openFile}
              onClick={() => useLayoutStore.getState().openFile(workspaceId, content.path ?? '')}
            />
            <IconButton
              icon={ArrowSquareOutIcon}
              label={d.fileMenu.openExternal}
              onClick={external.open}
            />
          </>
        ) : null}
      </div>
      {external.error && !errorDismissed ? (
        <StatusLine role="alert" tone="error" onDismiss={dismissError}>
          {external.error}
        </StatusLine>
      ) : null}
      <div className="diff-body" ref={bodyRef}>
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
      </div>
    </div>
  )
}
