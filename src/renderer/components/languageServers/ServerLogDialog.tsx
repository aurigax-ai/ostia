import type {
  LanguageServerInfo,
  LspLog,
  LspLogEntry,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { Dict } from '@shared/app/dict'
import { type JSX, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDate, TIME_24H } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'

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
      return t.logFetchRemoved
  }
}

export function ServerLogDialog({
  server,
  onClose,
}: {
  server: LanguageServerInfo
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const locale = useSettingsStore((s) => s.locale)
  const [log, setLog] = useState<LspLog | null>(null)
  useEffect(() => {
    let live = true
    void window.ostia.lsp.log(server.key).then((next) => {
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
          <DialogDescription>{t.logDesc}</DialogDescription>
        </DialogHeader>
        {log && log.entries.length === 0 ? (
          <p className="text-fg-muted text-ui-sm">{t.logEmpty}</p>
        ) : (
          <ol
            aria-label={fmt(t.logTitle, { name: server.name })}
            className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-sm border border-line bg-bg-sunken px-2 py-1.5 font-mono text-ui-xs"
          >
            {(log?.entries ?? []).map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the index tells repeated entries apart and the list is rebuilt, never reordered
              <li key={`${entry.at}-${i}`} className="flex min-w-0 gap-2">
                <span className="shrink-0 text-fg-muted tabular-nums">
                  {formatDate(entry.at, locale, TIME_24H)}
                </span>
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
