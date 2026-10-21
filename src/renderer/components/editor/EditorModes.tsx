import { CodeIcon, EyeIcon, PlayIcon } from '@phosphor-icons/react'
import type { MutableRefObject } from 'react'
import type { SelectionSend } from '@/components/agents/SelectionSend'
import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/lib/app/useDict'
import { HtmlPreview } from './HtmlPreview'

export interface OptionViewer {
  name: string
  show: () => void
}

interface EditorModesProps {
  workspaceId: string
  paneId: string
  filePath?: string
  visible: boolean
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
      {optionViewer && !runnable ? (
        <IconButton
          className="editor-mode"
          icon={EyeIcon}
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
    </>
  )
}
