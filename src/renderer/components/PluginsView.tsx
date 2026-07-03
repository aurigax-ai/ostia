import { useEffect } from 'react'
import { useDict } from '../i18n/useDict'
import { type Plugin, type PluginStatus, usePluginsStore } from '../stores/pluginsStore'

/** Status → dot color class (see index.css .plugin-dot.*). */
const STATUS_DOT: Record<PluginStatus, string> = {
  running: 'ok',
  available: 'brand',
  unavailable: 'dim',
  error: 'attn',
}

/**
 * The Plugins view — the plugin registry's status board. Today it lists the configured
 * language servers (running / installed / not installed / error); themes, agents, and
 * user-installable plugins slot in here later.
 */
export function PluginsView(): JSX.Element {
  const d = useDict()
  const plugins = usePluginsStore((s) => s.plugins)
  const load = usePluginsStore((s) => s.load)

  useEffect(() => {
    void load()
  }, [load])

  const statusLabel = (status: PluginStatus): string =>
    status === 'running'
      ? d.plugins.running
      : status === 'available'
        ? d.plugins.available
        : status === 'error'
          ? d.plugins.error
          : d.plugins.notInstalled

  const servers = plugins.filter((p) => p.kind === 'language-server')

  return (
    <>
      <div className="rail-section">{d.rail.plugins}</div>
      <div className="plugins">
        <div className="plugin-group">{d.plugins.languageServers}</div>
        {servers.length === 0 ? (
          <div className="rail-empty">{d.plugins.empty}</div>
        ) : (
          servers.map((p) => <PluginRow key={p.id} plugin={p} status={statusLabel(p.status)} />)
        )}
      </div>
    </>
  )
}

function PluginRow({ plugin, status }: { plugin: Plugin; status: string }): JSX.Element {
  return (
    <div className="plugin" title={`${plugin.name} · ${plugin.detail}`}>
      <span className={`dot plugin-dot ${STATUS_DOT[plugin.status]}`} />
      <span className="plugin-body">
        <span className="plugin-name">{plugin.name}</span>
        <span className="plugin-meta">
          {plugin.detail} · {status}
        </span>
      </span>
    </div>
  )
}
