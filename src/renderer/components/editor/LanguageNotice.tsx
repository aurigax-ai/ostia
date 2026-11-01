import type { LanguageServerInfo } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { ExtensionSuggestion } from '@shared/extensions/extensionSuggestions'
import type { MarketplaceError } from '@shared/extensions/marketplace'
import { type JSX, useEffect, useState } from 'react'
import { StatusAction, StatusLine, useDismissed } from '@/components/common/StatusLine'
import { fmt, useDict } from '@/lib/app/useDict'
import { fileLanguage } from '@/lib/monaco/language'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useLanguageNoticeStore } from '@/stores/extensions/languageNoticeStore'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'

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

function Bar({
  tone,
  actions,
  dismissKey,
  children,
}: {
  tone?: 'muted' | 'warn'
  actions?: React.ReactNode
  dismissKey?: string
  children: React.ReactNode
}): JSX.Element | null {
  const d = useDict()
  const [dismissed, dismiss] = useDismissed(dismissKey ?? '')
  if (dismissed) return null
  return (
    <StatusLine
      tone={tone}
      aria-label={d.languageNotice.label}
      actions={actions}
      onDismiss={dismissKey ? dismiss : undefined}
    >
      {children}
    </StatusLine>
  )
}

export function LargeFileNotice(): JSX.Element | null {
  const d = useDict()
  return <Bar dismissKey="large-file">{d.editor.largeFile}</Bar>
}

function ServerBar({ server }: { server: LanguageServerInfo }): JSX.Element {
  const d = useDict()
  const t = d.languageNotice
  const openExtension = (): void =>
    useUIStore
      .getState()
      .openSettings('extensions', { extension: server.extId, extensionRow: true })
  if (server.status === 'downloading') {
    return <Bar>{fmt(t.downloading, { name: server.name, percent: server.progress ?? 0 })}</Bar>
  }
  if (server.status === 'installing') {
    return <Bar>{fmt(t.installingServer, { name: server.name })}</Bar>
  }
  const text =
    server.status === 'program-missing'
      ? fmt(t.programMissing, { name: server.name, program: server.program ?? server.command })
      : server.status === 'toolchain-missing'
        ? fmt(t.toolchainMissing, { name: server.name })
        : fmt(t.fetchFailed, { name: server.name })
  return (
    <Bar
      tone="warn"
      dismissKey={`${server.name}:${server.status}`}
      actions={<StatusAction onClick={openExtension}>{t.openSettings}</StatusAction>}
    >
      {text}
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
  const suggestText = { language: t.suggest, view: t.suggestView, browse: t.suggestBrowse }
  const disabledText = { language: t.disabled, view: t.disabledView, browse: t.disabledBrowse }
  const text =
    suggestion.kind === 'install'
      ? fmt(suggestText[suggestion.feature], { name, files })
      : suggestion.pending
        ? fmt(t.pending, { name })
        : fmt(disabledText[suggestion.feature], { name, files })
  const action =
    suggestion.kind === 'install' ? (
      <StatusAction disabled={busy} onClick={() => void install()}>
        {busy ? t.installing : t.install}
      </StatusAction>
    ) : suggestion.pending ? (
      <StatusAction onClick={() => useExtensionsStore.getState().review(extId)}>
        {t.review}
      </StatusAction>
    ) : (
      <StatusAction
        onClick={() => useUIStore.getState().openSettings('extensions', { extension: extId })}
      >
        {t.openSettings}
      </StatusAction>
    )
  const more = others > 0 ? ` ${fmt(t.more, { count: others })}` : ''
  const failed = failure ? ` ${fmt(t.installFailed, { error: d.marketplace.errors[failure] })}` : ''
  return (
    <StatusLine
      aria-label={t.label}
      role={failure ? 'alert' : undefined}
      actions={action}
      onDismiss={decline}
      dismissDisabled={busy}
      tone={failure ? 'warn' : 'muted'}
    >
      {`${text}${more}${failed}`}
    </StatusLine>
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
  if (suggestion)
    return <SuggestionBar suggestion={suggestion} onGone={() => setSuggestion(null)} />
  return null
}
