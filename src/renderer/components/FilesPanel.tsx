import type { KeyboardEvent } from 'react'
import { useDict } from '../i18n/useDict'
import { matchChord } from '../lib/chords'
import { FILES_WIDTH } from '../lib/panelWidth'
import { isMac } from '../platform'
import { useUIStore } from '../stores/uiStore'
import { FilesView } from './FilesView'
import { PanelResizer } from './PanelResizer'

const FILES_PANEL_ID = 'files-panel'

function focusSearch(e: KeyboardEvent<HTMLElement>): void {
  if (matchChord(e, isMac) !== 'find') return
  e.preventDefault()
  useUIStore.getState().searchFiles()
}

export function FilesPanel(): JSX.Element {
  const d = useDict()
  return (
    <aside
      id={FILES_PANEL_ID}
      className="files-panel"
      aria-label={d.rail.files}
      onKeyDown={focusSearch}
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
