import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { isMac } from '../platform'
import { Hint } from './Hint'

export function WindowControls(): JSX.Element | null {
  const d = useDict()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    window.pine.window.isMaximized().then((v) => {
      if (alive) setMaximized(v)
    })
    const off = window.pine.window.onMaximizeChange(setMaximized)
    return () => {
      alive = false
      off()
    }
  }, [])

  if (isMac) return null

  return (
    <div className="win-controls no-drag">
      <Hint label={d.window.minimize} side="bottom">
        <button type="button" onClick={() => window.pine.window.minimize()}>
          <Minus size={16} />
        </button>
      </Hint>
      <Hint label={maximized ? d.window.restore : d.window.maximize} side="bottom">
        <button type="button" onClick={() => window.pine.window.toggleMaximize()}>
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
      </Hint>
      <Hint label={d.window.close} side="bottom">
        <button type="button" className="close" onClick={() => window.pine.window.close()}>
          <X size={16} />
        </button>
      </Hint>
    </div>
  )
}
