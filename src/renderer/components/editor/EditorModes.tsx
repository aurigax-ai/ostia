import { CodeIcon, EyeIcon, PaperPlaneTiltIcon, PlayIcon, TableIcon } from '@phosphor-icons/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { SelectionSend } from '@/components/agents/SelectionSend'
import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/lib/app/useDict'
import { HtmlPreview } from './HtmlPreview'
import { MarkdownPreview, type PreviewSelection } from './MarkdownPreview'

export interface OptionViewer {
  name: string
  show: () => void
}

interface EditorModesProps {
  workspaceId: string
  paneId: string
  filePath?: string
  visible: boolean
  markdown: boolean
  preview: boolean
  setPreview: Dispatch<SetStateAction<boolean>>
  previewText: string
  previewSelectionRef: MutableRefObject<PreviewSelection | null>
  sendSelectionRef: MutableRefObject<() => void>
  selectionSend: Pick<SelectionSend, 'open'>
  running: boolean
  runnable: boolean
  optionViewer?: OptionViewer
  setRunChoice: (choice: { file: string; on: boolean }) => void
  overlayRef: MutableRefObject<HTMLElement | null>
}

export function EditorModes({
  workspaceId,
  paneId,
  filePath,
  visible,
  markdown,
  preview,
  setPreview,
  previewText,
  previewSelectionRef,
  sendSelectionRef,
  selectionSend,
  running,
  runnable,
  optionViewer,
  setRunChoice,
  overlayRef,
}: EditorModesProps): JSX.Element {
  const d = useDict()
  return (
    <>
      {markdown && preview ? (
        <MarkdownPreview
          source={previewText}
          focusRef={overlayRef}
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
          focusRef={overlayRef}
          onSendErrors={(count, text) =>
            selectionSend.open({ kind: 'preview-error', file: filePath, count, text })
          }
          onSendRegion={(capture, image, anchor) => selectionSend.open(capture, image, anchor)}
        />
      ) : null}
      {optionViewer && !markdown && !runnable ? (
        <IconButton
          className="editor-mode"
          icon={TableIcon}
          label={fmt(d.viewer.showWith, { name: optionViewer.name })}
          hintSide="left"
          onClick={optionViewer.show}
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
    </>
  )
}
