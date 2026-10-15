import type { SelectionSend } from '@/components/agents/SelectionSend'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import { csvDelimiter } from '@/lib/files/csvTable'
import { CodeIcon, EyeIcon, PaperPlaneTiltIcon, PlayIcon, TableIcon } from '@phosphor-icons/react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { CsvTable } from './CsvTable'
import { HtmlPreview } from './HtmlPreview'
import { MarkdownPreview, type PreviewSelection } from './MarkdownPreview'

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
  tabled: boolean
  tabular: boolean
  tableText: string
  setRunChoice: (choice: { file: string; on: boolean }) => void
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
  tabled,
  tabular,
  tableText,
  setRunChoice,
}: EditorModesProps): JSX.Element {
  const d = useDict()
  return (
    <>
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
          onSendRegion={(capture, image) => selectionSend.open(capture, image)}
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
    </>
  )
}
