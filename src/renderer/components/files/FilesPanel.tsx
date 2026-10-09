import { PanelResizer } from '@/components/common/PanelResizer'
import { useDict } from '@/i18n/useDict'
import { matchChord } from '@/lib/chords'
import { FILES_WIDTH } from '@/lib/panelWidth'
import { isMac } from '@/platform'
import { useUIStore } from '@/stores/uiStore'
import type { KeyboardEvent } from 'react'
import { FilesView } from './FilesView'

const FILES_PANEL_ID = 'files-panel'

function toggleSearch(e: KeyboardEvent<HTMLElement>): void {
  if (matchChord(e, isMac) !== 'find') return
  e.preventDefault()
  useUIStore.getState().toggleFilesSearch(e.target)
}

export function FilesPanel(): JSX.Element {
  const d = useDict()
  return (
    <aside
      id={FILES_PANEL_ID}
      className="files-panel"
      aria-label={d.rail.files}
      onKeyDown={toggleSearch}
    >
      <FilesView />
      <PanelResizer
        spec={FILES_WIDTH}
        label={d.rail.resizeFiles}
        controls={FILES_PANEL_ID}
        className="files-resizer"
      />
    </aside>
  )
}
