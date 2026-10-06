import { useDict } from '../i18n/useDict'
import { useChordLabel } from '../lib/chords'
import { activeFontZoom, resetZoom } from '../lib/wheelZoom'
import { isMac } from '../platform'
import { useSettingsStore } from '../stores/settingsStore'
import { Hint } from './Hint'
import { Button } from './ui/button'

export function ZoomReset(): JSX.Element | null {
  const d = useDict()
  const percent = useSettingsStore((s) => activeFontZoom(s.appearance))
  const keys = useChordLabel('view.zoomReset', isMac)
  if (percent === null) return null
  return (
    <Hint label={keys ? `${d.topbar.resetZoom} (${keys})` : d.topbar.resetZoom} side="bottom">
      <Button
        variant="ghost"
        size="xs"
        aria-label={d.topbar.resetZoom}
        className="rounded-sm px-1.5 text-fg-muted tabular-nums hover:bg-surface-3 hover:text-fg dark:hover:bg-surface-3"
        onClick={resetZoom}
      >
        {percent}%
      </Button>
    </Hint>
  )
}
