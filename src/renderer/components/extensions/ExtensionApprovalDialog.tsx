import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict, withProductName } from '@/i18n/useDict'
import { pendingApproval, useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { ExtensionAgentPlugin } from './ExtensionAgentPlugin'

export function ExtensionApprovalDialog(): JSX.Element {
  const d = useDict()
  const ext = useExtensionsStore((s) =>
    s.reviewing ? (s.list.find((e) => e.id === s.reviewing) ?? null) : pendingApproval(s),
  )
  const approve = useExtensionsStore((s) => s.approve)
  const setEnabled = useExtensionsStore((s) => s.setEnabled)
  const dismiss = useExtensionsStore((s) => s.dismiss)

  const caps = ext?.requested ?? []

  return (
    <Dialog
      open={ext !== null}
      onOpenChange={(open) => {
        if (!open && ext) dismiss(ext.id)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{fmt(d.extensions.approveTitle, { name: ext?.name ?? '' })}</DialogTitle>
          <DialogDescription>
            {caps.length > 0
              ? fmt(d.extensions.approveBody, {
                  name: ext?.name ?? '',
                  version: ext?.version ?? '',
                })
              : d.extensions.approveNone}
          </DialogDescription>
        </DialogHeader>
        {ext?.description ? (
          <p className="text-fg-muted text-ui-sm">{withProductName(ext.description)}</p>
        ) : null}
        {caps.length > 0 ? (
          <ul aria-label={d.extensions.permissions} className="flex flex-wrap gap-1.5">
            {caps.map((cap) => (
              <li key={cap}>
                <Badge variant="outline" className="font-mono text-ui-xs">
                  {cap}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {ext && ext.languageServers.length > 0 ? (
          <ul aria-label={d.languageServers.runsTitle} className="flex flex-col gap-1">
            {ext.languageServers.map((server) => (
              <li key={server.id} className="text-fg-muted text-ui-sm">
                {fmt(d.languageServers.runs, {
                  command: server.command,
                  languages: server.languages.join(', '),
                })}
                {server.download ? (
                  <span className="block">{fmt(d.languageServers.downloads, server.download)}</span>
                ) : null}
                {server.goInstall ? (
                  <span className="block">
                    {fmt(d.languageServers.goInstalls, server.goInstall)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {ext ? <ExtensionAgentPlugin ext={ext} explain /> : null}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!ext) return
              dismiss(ext.id)
              void setEnabled(ext.id, false)
            }}
          >
            {d.extensions.deny}
          </Button>
          <Button size="sm" onClick={() => ext && void approve(ext.id)}>
            {d.extensions.approve}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
