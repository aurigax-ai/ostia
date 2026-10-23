import { CodeIcon, EyeIcon, PlayIcon } from '@phosphor-icons/react'
import type { MutableRefObject } from 'react'
import type { SelectionSend } from '@/components/agents/SelectionSend'
import { fmt, useDict } from '@/lib/app/useDict'
import { FloatPill, FloatPillButton } from './FloatPill'
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
}: EditorModesProps): JSX.Element | null {
  const d = useDict()
  const mode =
    optionViewer && !runnable ? (
      <FloatPillButton
        icon={EyeIcon}
        label={fmt(d.viewer.showWith, { name: optionViewer.name })}
        onClick={optionViewer.show}
      />
    ) : runnable && filePath ? (
      <FloatPillButton
        icon={running ? CodeIcon : PlayIcon}
        label={running ? d.preview.editSource : d.preview.run}
        onClick={() => setRunChoice({ file: filePath, on: !running })}
      />
    ) : null
  if (running && filePath) {
    return (
      <HtmlPreview
        key={filePath}
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={filePath}
        visible={visible}
        focusRef={overlayRef}
        mode={mode}
        onSendErrors={(count, text) =>
          selectionSend.open({ kind: 'preview-error', file: filePath, count, text })
        }
        onSendRegion={(capture, image, anchor) => selectionSend.open(capture, image, anchor)}
      />
    )
  }
  return mode ? <FloatPill label={d.preview.controls}>{mode}</FloatPill> : null
}
