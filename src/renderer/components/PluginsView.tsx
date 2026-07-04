import { useEffect } from 'react'
import { useDict } from '../i18n/useDict'
import { type LspEntry, type LspStatus, usePluginsStore } from '../stores/pluginsStore'

/** Status → dot color class (see index.css .plugin-dot.*). */
const STATUS_DOT: Record<LspStatus, string> = {
  running: 'ok',
  installed: 'brand',
  missing: 'dim',
  error: 'attn',
}

/**
 * The Plugins view — the plugin registry's status board. Today it lists the configured
 * language servers (running / installed / not installed / error); themes, agents, and
 * user-installable plugins slot in here later.
 */
export function PluginsView(): JSX.Element {
  const d = useDict()
  const lsp = usePluginsStore((s) => s.lsp)
  const load = usePluginsStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

  const statusLabel = (status: LspStatus): string =>
    status === 'running'
      ? d.plugins.running
      : status === 'installed'
        ? d.plugins.available
        : status === 'error'
          ? d.plugins.error
          : d.plugins.notInstalled

  return (
    <>
      <div className="rail-section">{d.rail.plugins}</div>
      <div className="plugins">
        <div className="plugin-group">{d.plugins.languageServers}</div>
        {lsp.length === 0 ? (
          <div className="rail-empty">{d.plugins.empty}</div>
        ) : (
          lsp.map((e) => <PluginRow key={e.languageId} entry={e} status={statusLabel(e.status)} />)
        )}
      </div>
    </>
  )
}

function PluginRow({ entry, status }: { entry: LspEntry; status: string }): JSX.Element {
  return (
    <div className="plugin" title={`${entry.command} · ${entry.languageId}`}>
      <span className={`dot plugin-dot ${STATUS_DOT[entry.status]}`} />
      <span className="plugin-body">
        <span className="plugin-name">{entry.command}</span>
        <span className="plugin-meta">
          {entry.languageId} · {status}
        </span>
      </span>
    </div>
  )
}
