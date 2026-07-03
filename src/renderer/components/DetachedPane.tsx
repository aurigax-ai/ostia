import type { PaneDescriptor } from '@shared/types'
import { useEffect, useState } from 'react'
import { isMac } from '../platform'
import { WindowControls } from './WindowControls'

/**
 * A torn-off pane in its own window: just the pane, window controls, and a draggable
 * header strip. A minimal "satellite" of the main shell — no sidebar or tabs.
 */
export function DetachedPane(): JSX.Element {
  const [descriptor, setDescriptor] = useState<PaneDescriptor | null>(null)

  useEffect(() => {
    window.pine.window.getDetachedPane().then(setDescriptor)
  }, [])

  return (
    <div className={`detached${isMac ? ' is-mac' : ''}`}>
      <div className="pane">
        <div className="pane-header drag-region">
          <span className="title">{descriptor?.title ?? '…'}</span>
        </div>
        <div className="pane-body">
          <span className="ghost">detached pane</span>
        </div>
      </div>
      <WindowControls />
    </div>
  )
}
