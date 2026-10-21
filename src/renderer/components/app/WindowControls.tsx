import { CopyIcon, MinusIcon, SquareIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useDict } from '@/lib/app/useDict'
import { isMac } from '@/platform'

export function WindowControls(): JSX.Element | null {
  const d = useDict()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    window.ostia.window.isMaximized().then((v) => {
      if (alive) setMaximized(v)
    })
    const off = window.ostia.window.onMaximizeChange(setMaximized)
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
        onClick={() => window.ostia.window.minimize()}
      >
        <MinusIcon size={16} />
      </button>
      <button
        type="button"
        aria-label={maximized ? d.window.restore : d.window.maximize}
        onClick={() => window.ostia.window.toggleMaximize()}
      >
        {maximized ? <CopyIcon size={16} /> : <SquareIcon size={16} />}
      </button>
      <button type="button" aria-label={d.window.close} onClick={() => window.ostia.window.close()}>
        <XIcon size={16} />
      </button>
    </div>
  )
}
