import { useDict } from '../i18n/useDict'
import { FILES_WIDTH } from '../lib/panelWidth'
import { FilesView } from './FilesView'
import { PanelResizer } from './PanelResizer'

const FILES_PANEL_ID = 'files-panel'

export function FilesPanel(): JSX.Element {
  const d = useDict()
  return (
    <aside id={FILES_PANEL_ID} className="files-panel" aria-label={d.rail.files}>
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
