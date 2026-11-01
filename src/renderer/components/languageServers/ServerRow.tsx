import type {
  LanguageServerInfo,
  LanguageServerStatus,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import {
  ArrowClockwiseIcon,
  DownloadSimpleIcon,
  ListMagnifyingGlassIcon,
  TrashIcon,
  WrenchIcon,
} from '@phosphor-icons/react'
import { type JSX, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { useRequirements } from '@/components/settings/RequirementsNote'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { fmt, useDict } from '@/lib/app/useDict'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ServerLogDialog } from './ServerLogDialog'
import { ServerProgramDialog } from './ServerProgramDialog'
import { binaryNote, sandboxReason, statusLabel } from './serverStatusText'

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
  'override-invalid': 'bg-attn',
  crashed: 'bg-attn',
  'pending-approval': 'bg-fg-dim',
}

function InstallProgram({ server }: { server: LanguageServerInfo }): JSX.Element | null {
  const d = useDict()
  const t = d.languageServers
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const { report, installing, install } = useRequirements(server.requirement ?? null)
  if (!report || report.missing.length === 0) return null
  const command = report.hint.command
  if (report.canInstall && workspaceId) {
    return (
      <div className="mt-1 flex items-center gap-2">
        <Button
          variant="secondary"
          size="xs"
          disabled={installing}
          onClick={() => install(workspaceId)}
        >
          {fmt(t.install, { name: server.name })}
        </Button>
        {installing ? (
          <span className="text-fg-muted text-ui-xs">{d.requirements.installing}</span>
        ) : null}
      </div>
    )
  }
  return (
    <div className="mt-1">
      <p className="text-fg-muted text-ui-xs">
        {command
          ? d.requirements.cantInstall
          : fmt(d.requirements.cantInstallNoCommand, { packages: report.hint.packages.join(', ') })}
      </p>
      {command ? (
        <div className="mt-1 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-fg text-ui-xs">{command}</code>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void navigator.clipboard?.writeText(command)}
          >
            {t.copyCommand}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function ServerRow({ server }: { server: LanguageServerInfo }): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const setEnabled = useLanguageServersStore((s) => s.setEnabled)
  const restart = useLanguageServersStore((s) => s.restart)
  const [showLog, setShowLog] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const reason = server.status === 'sandbox-unavailable' ? sandboxReason(d, server) : null
  const note = binaryNote(d, server)
  const failed = server.status === 'download-failed' || server.status === 'install-failed'
  const needsProgram = server.status === 'program-missing' || server.status === 'toolchain-missing'
  const canFetchNow =
    failed || (server.status === 'idle' && server.fetchable === true && !server.binary)
  const problem =
    needsProgram ||
    failed ||
    server.status === 'sandbox-unavailable' ||
    server.status === 'override-invalid' ||
    server.status === 'crashed'
  return (
    <fieldset
      aria-label={server.name}
      className="min-w-0"
      data-server-key={server.key}
      data-server-status={server.status}
    >
      <ControlRow
        label={server.name}
        labelHint={
          <>
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${STATUS_DOT[server.status]}`}
            />
            <Badge variant="outline" className="text-ui-xs">
              {t.kinds[server.kind]}
            </Badge>
          </>
        }
        below={
          <>
            <p className="break-words text-fg-muted text-ui-xs">
              {server.languages.join(', ')} ·{' '}
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
                onClick={() => void window.ostia.lsp.fetch(server.key)}
              >
                {t.retry}
              </Button>
            ) : null}
            {showLog ? <ServerLogDialog server={server} onClose={() => setShowLog(false)} /> : null}
            {choosing ? (
              <ServerProgramDialog server={server} onClose={() => setChoosing(false)} />
            ) : null}
          </>
        }
      >
        {canFetchNow && !failed ? (
          <IconButton
            icon={DownloadSimpleIcon}
            label={fmt(t.fetchNow, { name: server.name })}
            onClick={() => void window.ostia.lsp.fetch(server.key)}
          />
        ) : null}
        {server.managedCopy ? (
          <IconButton
            icon={TrashIcon}
            label={fmt(t.removeDownload, { name: server.name })}
            onClick={() => void window.ostia.lsp.removeDownload(server.key)}
          />
        ) : null}
        <IconButton
          icon={WrenchIcon}
          label={fmt(t.chooseProgram, { name: server.name })}
          disabled={server.status === 'pending-approval'}
          onClick={() => setChoosing(true)}
        />
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
      </ControlRow>
    </fieldset>
  )
}
