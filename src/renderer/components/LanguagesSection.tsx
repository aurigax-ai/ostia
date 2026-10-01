import {
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  ListMagnifyingGlassIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type {
  LanguageServerInfo,
  LanguageServerStatus,
  LspLog,
  LspLogEntry,
} from '@shared/languageServers'
import { PRODUCT_NAME } from '@shared/product'
import type { RequirementsReport } from '@shared/systemRequirements'
import { useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { useLanguageServersStore } from '../stores/languageServersStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { SectionHead } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Switch } from './ui/switch'

const STATUS_DOT: Record<LanguageServerStatus, string> = {
  running: 'bg-ok',
  idle: 'bg-fg-muted',
  off: 'bg-fg-dim',
  'program-missing': 'bg-attn',
  'toolchain-missing': 'bg-attn',
  downloading: 'bg-brand',
  'download-failed': 'bg-attn',
  installing: 'bg-brand',
  'install-failed': 'bg-attn',
  'sandbox-unavailable': 'bg-attn',
  crashed: 'bg-attn',
  'pending-approval': 'bg-fg-dim',
}

function failureReason(d: Dict, server: LanguageServerInfo): string {
  if (!server.failure) return ''
  return fmt(d.languageServers.fetchReasons[server.failure], {
    detail: server.failureDetail ?? '',
  })
}

function binaryNote(d: Dict, server: LanguageServerInfo): string | null {
  const t = d.languageServers
  if (!server.enabled || server.kind === 'bundled' || server.kind === 'program') return null
  if (server.binary?.source === 'path') {
    return fmt(t.usingPath, { program: server.program ?? server.command })
  }
  if (server.binary?.source === 'managed') {
    return fmt(t.usingManaged, { app: PRODUCT_NAME, version: server.version ?? '' })
  }
  if (!server.fetchable || server.fetchHeld) return null
  return server.fetchCommand
    ? fmt(t.willGoInstall, { app: PRODUCT_NAME, command: server.fetchCommand })
    : fmt(t.willDownload, { app: PRODUCT_NAME, version: server.version ?? '' })
}

function statusLabel(d: Dict, server: LanguageServerInfo): string {
  const t = d.languageServers
  switch (server.status) {
    case 'running':
      return server.folders === 1
        ? t.statusRunningOne
        : fmt(t.statusRunningMany, { count: server.folders })
    case 'idle':
      return t.statusIdle
    case 'off':
      return t.statusOff
    case 'program-missing':
      return fmt(t.statusMissing, { program: server.program ?? server.command })
    case 'toolchain-missing':
      return t.statusToolchain
    case 'downloading':
      return fmt(t.statusDownloading, { percent: server.progress ?? 0 })
    case 'download-failed':
      return fmt(t.statusDownloadFailed, { reason: failureReason(d, server) })
    case 'installing':
      return t.statusInstalling
    case 'install-failed':
      return fmt(t.statusInstallFailed, { reason: failureReason(d, server) })
    case 'sandbox-unavailable':
      return t.statusSandbox
    case 'crashed':
      return t.statusCrashed
    case 'pending-approval':
      return t.statusPending
  }
}

function sandboxReason(d: Dict, server: LanguageServerInfo): string | null {
  const t = d.languageServers
  const detail = server.sandboxDetail ?? ''
  switch (server.sandboxProblem) {
    case 'program-unreadable':
      return fmt(t.sandboxProgram, { path: detail })
    case 'folder-unreadable':
      return fmt(t.sandboxFolder, { path: detail })
    case 'wrap-failed':
      return fmt(t.sandboxWrap, { error: detail })
    default:
      return null
  }
}

function logLine(d: Dict, entry: LspLogEntry): string {
  const t = d.languageServers
  switch (entry.kind) {
    case 'start':
      return fmt(entry.sandboxed ? t.logStartSandboxed : t.logStart, { pid: entry.pid })
    case 'initialized':
      return fmt(t.logInitialized, { name: `${entry.name} ${entry.version}`.trim() })
    case 'exit':
      return entry.signal
        ? fmt(t.logExitSignal, { signal: entry.signal })
        : fmt(t.logExit, { code: entry.code ?? '' })
    case 'restart':
      return fmt(t.logRestart, {
        delay: entry.delayMs,
        attempt: entry.attempt,
        limit: entry.limit,
      })
    case 'crashed':
      return t.logCrashed
    case 'stop':
      return t.logStop[entry.reason]
    case 'spawn-failed':
      return fmt(t.logSpawnFailed, { error: entry.text })
    case 'stderr':
    case 'fetch-output':
      return entry.text
    case 'fetch-start':
      return fmt(entry.how === 'download' ? t.logFetchDownload : t.logFetchGoInstall, {
        version: entry.version,
      })
    case 'fetch-done':
      return fmt(t.logFetchDone, { version: entry.version })
    case 'fetch-failed':
      return fmt(t.logFetchFailed, {
        reason: fmt(t.fetchReasons[entry.reason], { detail: entry.detail }),
      })
    case 'fetch-removed':
      return fmt(t.logFetchRemoved, { app: PRODUCT_NAME })
  }
}

function logTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false })
}

function ServerLogDialog({
  server,
  onClose,
}: {
  server: LanguageServerInfo
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const [log, setLog] = useState<LspLog | null>(null)
  useEffect(() => {
    let live = true
    void window.pine.lsp.log(server.key).then((next) => {
      if (live) setLog(next)
    })
    return () => {
      live = false
    }
  }, [server.key])
  const errors = Object.entries(log?.errors ?? {})
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{fmt(t.logTitle, { name: server.name })}</DialogTitle>
          <DialogDescription>{fmt(t.logDesc, { app: PRODUCT_NAME })}</DialogDescription>
        </DialogHeader>
        {log && log.entries.length === 0 ? (
          <p className="text-fg-muted text-ui-sm">{t.logEmpty}</p>
        ) : (
          <ol
            aria-label={fmt(t.logTitle, { name: server.name })}
            className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-sm border border-line bg-bg-sunken px-2 py-1.5 font-mono text-ui-xs"
          >
            {(log?.entries ?? []).map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="flex min-w-0 gap-2">
                <span className="shrink-0 text-fg-muted tabular-nums">{logTime(entry.at)}</span>
                <span
                  className={
                    entry.kind === 'stderr' || entry.kind === 'fetch-output'
                      ? 'min-w-0 break-words text-fg-muted'
                      : 'min-w-0 break-words text-fg'
                  }
                >
                  {logLine(d, entry)}
                </span>
              </li>
            ))}
          </ol>
        )}
        {errors.length > 0 ? (
          <div className="text-ui-xs">
            <p className="text-fg-muted">{t.logErrors}</p>
            <ul className="mt-0.5 font-mono text-fg">
              {errors.map(([method, count]) => (
                <li key={method} className="flex gap-2">
                  <span className="tabular-nums">{count}</span>
                  <span>{method}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function InstallProgram({ server }: { server: LanguageServerInfo }): JSX.Element | null {
  const d = useDict()
  const t = d.languageServers
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const [report, setReport] = useState<RequirementsReport | null>(null)
  const feature = server.requirement
  useEffect(() => {
    if (!feature) return
    let live = true
    void window.pine.system.requirements(feature).then((next) => {
      if (live) setReport(next)
    })
    return () => {
      live = false
    }
  }, [feature])
  if (!feature || !report || report.missing.length === 0) return null
  const command = report.hint.command
  if (report.canInstall && workspaceId) {
    return (
      <Button
        size="sm"
        onClick={() => void window.pine.system.installRequirements(feature, workspaceId)}
      >
        {fmt(t.install, { name: server.name })}
      </Button>
    )
  }
  if (!command) return null
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate font-mono text-fg text-ui-xs">{command}</code>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void navigator.clipboard?.writeText(command)}
      >
        {t.copyCommand}
      </Button>
    </div>
  )
}

function ServerRow({ server }: { server: LanguageServerInfo }): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const setEnabled = useLanguageServersStore((s) => s.setEnabled)
  const restart = useLanguageServersStore((s) => s.restart)
  const [showLog, setShowLog] = useState(false)
  const reason = server.status === 'sandbox-unavailable' ? sandboxReason(d, server) : null
  const note = binaryNote(d, server)
  const failed = server.status === 'download-failed' || server.status === 'install-failed'
  const needsProgram = server.status === 'program-missing' || server.status === 'toolchain-missing'
  const canFetchNow =
    failed || (server.status === 'idle' && server.fetchable === true && !server.binary)
  const problem =
    needsProgram || failed || server.status === 'sandbox-unavailable' || server.status === 'crashed'
  return (
    <li
      aria-label={server.name}
      data-server-key={server.key}
      data-server-status={server.status}
      className="flex flex-col rounded-sm px-3 py-2"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-1 gap-2.5">
          <span
            aria-hidden
            className={`mt-1.5 size-2 shrink-0 rounded-full ${STATUS_DOT[server.status]}`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words text-fg text-ui-base">{server.name}</span>
              <Badge variant="outline" className="text-ui-xs">
                {t.kinds[server.kind]}
              </Badge>
            </div>
            <p className="mt-0.5 break-words text-fg-muted text-ui-xs">
              {server.extName} · {server.languages.join(', ')} ·{' '}
              <span className="break-all font-mono">{server.command}</span>
            </p>
            <p
              data-testid="language-server-status"
              className={`mt-0.5 text-ui-sm ${problem ? 'text-attn-fg' : 'text-fg-muted'}`}
            >
              {statusLabel(d, server)}
            </p>
            {reason ? <p className="mt-0.5 text-fg-muted text-ui-xs">{reason}</p> : null}
            {note ? <p className="mt-0.5 text-fg-muted text-ui-xs">{note}</p> : null}
            {needsProgram ? <InstallProgram server={server} /> : null}
            {failed ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => void window.pine.lsp.fetch(server.key)}
              >
                {t.retry}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canFetchNow && !failed ? (
            <IconButton
              icon={DownloadSimpleIcon}
              label={fmt(t.fetchNow, { name: server.name })}
              onClick={() => void window.pine.lsp.fetch(server.key)}
            />
          ) : null}
          {server.managedCopy ? (
            <IconButton
              icon={TrashIcon}
              label={fmt(t.removeDownload, { name: server.name, app: PRODUCT_NAME })}
              onClick={() => void window.pine.lsp.removeDownload(server.key)}
            />
          ) : null}
          <IconButton
            icon={ListMagnifyingGlassIcon}
            label={fmt(t.showLog, { name: server.name })}
            onClick={() => setShowLog(true)}
          />
          <IconButton
            icon={ArrowClockwiseIcon}
            label={fmt(t.restart, { name: server.name })}
            disabled={!server.enabled}
            onClick={() => void restart(server.key)}
          />
          <Switch
            checked={server.enabled}
            disabled={server.status === 'pending-approval'}
            onCheckedChange={(v) => void setEnabled(server.key, v)}
            aria-label={fmt(t.enable, { name: server.name })}
          />
        </div>
      </div>
      {showLog ? <ServerLogDialog server={server} onClose={() => setShowLog(false)} /> : null}
    </li>
  )
}

export function LanguagesSection(): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const servers = useLanguageServersStore((s) => s.list)
  const load = useLanguageServersStore((s) => s.load)
  useEffect(() => {
    void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])
  return (
    <section aria-label={t.title}>
      <SectionHead title={t.title} desc={t.desc} />
      {servers.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{t.none}</p>
      ) : (
        <ul className="-mx-3 flex flex-col">
          {servers.map((server) => (
            <ServerRow key={server.key} server={server} />
          ))}
        </ul>
      )}
    </section>
  )
}
