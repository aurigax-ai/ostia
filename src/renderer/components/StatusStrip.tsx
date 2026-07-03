import type { AppInfo } from '@shared/types'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { paneIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { UsageMeter } from './UsageMeter'

/** Bottom strip: quiet mono data + ambient telemetry. Real branch/cwd land in Phase 4. */
export function StatusStrip(): JSX.Element {
  const d = useDict()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const sessions = useSessionsStore((s) => s.sessions)
  const sessionId = useSessionsStore((s) => s.activeSessionId)
  const layout = useLayoutStore((s) => s.bySession[sessionId])

  useEffect(() => {
    window.pine
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const busy = sessions.filter((c) => c.state === 'working').length
  const waiting = sessions.filter((c) => c.state === 'waiting').length
  const paneCount = layout ? paneIds(layout.root).length : 0

  return (
    <footer className="status-strip">
      <span className="status-seg accent"> main ↑2</span>
      <span className="status-seg">{fmt(d.status.working, { n: busy })}</span>
      {waiting > 0 ? (
        <span className="status-seg">{fmt(d.status.waiting, { n: waiting })}</span>
      ) : null}
      <span className="status-seg">{fmt(d.status.panes, { n: paneCount })}</span>
      <span className="status-spacer" />
      <span className="status-seg">
        <UsageMeter label="ctx" filled={5} total={8} value="58%" tone="accent" />
      </span>
      <span className="status-seg">
        <UsageMeter label="wk" filled={7} total={8} value="90%" tone="attn" />
      </span>
      <span className="status-seg muted">{info ? `${info.name} v${info.version}` : '…'}</span>
    </footer>
  )
}
