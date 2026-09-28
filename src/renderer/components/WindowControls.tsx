import { CopyIcon, MinusIcon, SquareIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { isMac } from '../platform'

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
      <button
        type="button"
        aria-label={d.window.minimize}
        onClick={() => window.pine.window.minimize()}
      >
        <MinusIcon size={16} />
      </button>
      <button
        type="button"
        aria-label={maximized ? d.window.restore : d.window.maximize}
        onClick={() => window.pine.window.toggleMaximize()}
      >
        {maximized ? <CopyIcon size={12} /> : <SquareIcon size={12} />}
      </button>
      <button
        type="button"
        className="close"
        aria-label={d.window.close}
        onClick={() => window.pine.window.close()}
      >
        <XIcon size={16} />
      </button>
    </div>
  )
}
