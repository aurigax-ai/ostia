import type { LanguageServerInfo } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { Dict } from '@shared/app/dict'
import { fmt } from '@/lib/app/useDict'

function failureReason(d: Dict, server: LanguageServerInfo): string {
  if (!server.failure) return ''
  return fmt(d.languageServers.fetchReasons[server.failure], {
    detail: server.failureDetail ?? '',
  })
}

export function binaryNote(d: Dict, server: LanguageServerInfo): string | null {
  const t = d.languageServers
  if (server.override) return fmt(t.usingOverride, { path: server.override.path })
  if (!server.enabled || server.kind === 'bundled' || server.kind === 'program') return null
  if (server.binary?.source === 'path') {
    return fmt(t.usingPath, { program: server.program ?? server.command })
  }
  if (server.binary?.source === 'managed') {
    return fmt(t.usingManaged, { version: server.version ?? '' })
  }
  if (!server.fetchable || server.fetchHeld) return null
  return server.fetchCommand
    ? fmt(t.willGoInstall, { command: server.fetchCommand })
    : fmt(t.willDownload, { version: server.version ?? '' })
}

export function statusLabel(d: Dict, server: LanguageServerInfo): string {
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
    case 'override-invalid':
      return fmt(t.statusOverride, {
        reason: t.overrideReasons[server.override?.problem ?? 'missing'],
      })
    case 'crashed':
      return t.statusCrashed
    case 'pending-approval':
      return t.statusPending
  }
}

export function sandboxReason(d: Dict, server: LanguageServerInfo): string | null {
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
