import type { ExtensionSuggestion } from '@shared/extensionSuggestions'
import type { LanguageServerInfo } from '@shared/languageServers'
import type { MarketplaceError } from '@shared/marketplace'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { fileLanguage } from '../monaco/language'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLanguageNoticeStore } from '../stores/languageNoticeStore'
import { useLanguageServersStore } from '../stores/languageServersStore'
import { useUIStore } from '../stores/uiStore'
import { Button } from './ui/button'

const SERVER_NOTICES = [
  'downloading',
  'installing',
  'download-failed',
  'install-failed',
  'program-missing',
  'toolchain-missing',
] as const

type ServerNotice = (typeof SERVER_NOTICES)[number]

export function serverNoticeFor(
  servers: readonly LanguageServerInfo[],
  path: string,
): LanguageServerInfo | null {
  const language = fileLanguage(path)
  const claiming = servers.filter((s) => s.enabled && s.languages.includes(language))
  if (claiming.some((s) => s.status === 'running')) return null
  return claiming.find((s) => SERVER_NOTICES.includes(s.status as ServerNotice)) ?? null
}

function Bar({ children }: { children: React.ReactNode }): JSX.Element {
  const d = useDict()
  return (
    <output
      aria-label={d.languageNotice.label}
      className="language-notice flex items-center gap-2 border-line border-b bg-surface-2 px-3 text-fg-muted text-ui-sm"
    >
      {children}
    </output>
  )
}

export function LargeFileNotice(): JSX.Element {
  const d = useDict()
  return (
    <Bar>
      <span className="truncate">{d.editor.largeFile}</span>
    </Bar>
  )
}

function ServerBar({ server }: { server: LanguageServerInfo }): JSX.Element {
  const d = useDict()
  const t = d.languageNotice
  const openLanguages = (): void => useUIStore.getState().openSettings('languageServers')
  if (server.status === 'downloading') {
    return (
      <Bar>
        <span className="truncate">
          {fmt(t.downloading, { name: server.name, percent: server.progress ?? 0 })}
        </span>
      </Bar>
    )
  }
  if (server.status === 'installing') {
    return (
      <Bar>
        <span className="truncate">{fmt(t.installingServer, { name: server.name })}</span>
      </Bar>
    )
  }
  const text =
    server.status === 'program-missing'
      ? fmt(t.programMissing, { name: server.name, program: server.program ?? server.command })
      : server.status === 'toolchain-missing'
        ? fmt(t.toolchainMissing, { name: server.name })
        : fmt(t.fetchFailed, { name: server.name })
  return (
    <Bar>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <Button variant="outline" size="xs" onClick={openLanguages}>
        {t.openSettings}
      </Button>
    </Bar>
  )
}

function SuggestionBar({
  suggestion,
  onGone,
}: {
  suggestion: ExtensionSuggestion
  onGone: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.languageNotice
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MarketplaceError | null>(null)
  const { extId, name, files, others } = suggestion
  const decline = (): void => {
    void window.ostia.suggestions.dismiss(extId)
    onGone()
  }
  const install = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await window.ostia.suggestions.install(extId)
    setBusy(false)
    if (result.ok) onGone()
    else setFailure(result.error)
  }
  const text =
    suggestion.kind === 'install'
      ? fmt(t.suggest, { name, files })
      : suggestion.pending
        ? fmt(t.pending, { name })
        : fmt(t.disabled, { name, files })
  return (
    <Bar>
      <span className="min-w-0 flex-1 truncate">
        {text}
        {others > 0 ? ` ${fmt(t.more, { count: others })}` : ''}
        {failure ? (
          <span role="alert" className="ml-2 text-attn-fg">
            {fmt(t.installFailed, { error: d.marketplace.errors[failure] })}
          </span>
        ) : null}
      </span>
      {suggestion.kind === 'install' ? (
        <Button size="xs" disabled={busy} onClick={() => void install()}>
          {busy ? t.installing : t.install}
        </Button>
      ) : suggestion.pending ? (
        <Button size="xs" onClick={() => useExtensionsStore.getState().review(extId)}>
          {t.review}
        </Button>
      ) : (
        <Button
          size="xs"
          onClick={() => useUIStore.getState().openSettings('extensions', { extension: extId })}
        >
          {t.openSettings}
        </Button>
      )}
      <Button variant="outline" size="xs" disabled={busy} onClick={decline}>
        {t.no}
      </Button>
    </Bar>
  )
}

export function LanguageNotice({
  paneId,
  filePath,
}: {
  paneId: string
  filePath: string
}): JSX.Element | null {
  const servers = useLanguageServersStore((s) => s.list)
  const loadServers = useLanguageServersStore((s) => s.load)
  const extensions = useExtensionsStore((s) => s.list)
  const [suggestion, setSuggestion] = useState<ExtensionSuggestion | null>(null)
  const serverNotice = serverNoticeFor(servers, filePath)

  useEffect(() => {
    void loadServers()
  }, [loadServers])

  useEffect(() => {
    void extensions
    void servers
    let live = true
    void window.ostia.suggestions.forFile(paneId, filePath).then((next) => {
      if (!live) return
      const shown = next !== null && useLanguageNoticeStore.getState().claim(next.extId, paneId)
      setSuggestion(shown ? next : null)
    })
    return () => {
      live = false
    }
  }, [paneId, filePath, extensions, servers])

  useEffect(() => () => useLanguageNoticeStore.getState().release(paneId), [paneId])

  if (serverNotice) return <ServerBar server={serverNotice} />
  if (!suggestion) return null
  return <SuggestionBar suggestion={suggestion} onGone={() => setSuggestion(null)} />
}
