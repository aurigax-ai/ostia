import { type JSX, type MutableRefObject, useEffect, useRef } from 'react'
import { fmt, useDict } from '@/lib/app/useDict'
import { openCapture } from '@/lib/capture/captureSession'
import { selectionAdapter } from '@/lib/capture/selectionAdapter'
import { useViewModeStore, type ViewMode } from '@/stores/files/viewModeStore'
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
  running,
  runnable,
  optionViewer,
  setRunChoice,
  overlayRef,
}: EditorModesProps): JSX.Element | null {
  const d = useDict()
  const publish = useViewModeStore((s) => s.publish)
  const mode: ViewMode | null =
    optionViewer && !runnable
      ? {
          icon: 'viewer',
          label: fmt(d.viewer.showWith, { name: optionViewer.name }),
          act: optionViewer.show,
        }
      : runnable && filePath
        ? {
            icon: running ? 'source' : 'run',
            label: running ? d.preview.editSource : d.preview.run,
            act: () => setRunChoice({ file: filePath, on: !running }),
          }
        : null
  const actRef = useRef(mode?.act)
  actRef.current = mode?.act
  const icon = mode?.icon
  const label = mode?.label
  useEffect(() => {
    if (!icon || !label) return
    return publish(paneId, { icon, label, act: () => actRef.current?.() })
  }, [publish, paneId, icon, label])
  if (!running || !filePath) return null
  return (
    <HtmlPreview
      key={filePath}
      workspaceId={workspaceId}
      paneId={paneId}
      filePath={filePath}
      visible={visible}
      focusRef={overlayRef}
      onSendErrors={(count, text) =>
        openCapture(
          paneId,
          selectionAdapter({
            paneId,
            capture: { kind: 'preview-error', file: filePath, count, text },
            anchor: null,
          }),
        )
      }
    />
  )
}
