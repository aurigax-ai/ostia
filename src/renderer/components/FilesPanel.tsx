import { useDict } from '../i18n/useDict'
import { FilesView } from './FilesView'

export function FilesPanel(): JSX.Element {
  const d = useDict()
  return (
    <aside className="files-panel" aria-label={d.rail.files}>
      <FilesView />
    </aside>
  )
}
