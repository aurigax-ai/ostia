import type { McpServerSettings } from '@shared/assist/chatTools'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  draftFromServer,
  type McpDraftField,
  type McpServerDraft,
  serverFromDraft,
} from '@/lib/assist/mcpServerForm'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { refreshMcp } from '@/stores/assist/chatToolsStore'
import { SecretRows, ServerFields } from './McpServerFields'

export async function saveMcpServers(servers: McpServerSettings[]): Promise<void> {
  await useSettingsStore.getState().setChatTools({ mcpServers: servers })
  await refreshMcp()
}

async function storeServer(
  original: McpServerSettings | null,
  server: McpServerSettings,
  secretValues: Record<string, string>,
  removedSecrets: string[],
): Promise<boolean> {
  for (const key of removedSecrets) {
    await window.ostia.chatTools.setMcpSecret(server.name, key, null)
  }
  const servers = useSettingsStore.getState().assistant.mcpServers
  await useSettingsStore.getState().setChatTools({
    mcpServers: original
      ? servers.map((s) => (s.name === original.name ? server : s))
      : [...servers, server],
  })
  let ok = true
  for (const [key, value] of Object.entries(secretValues)) {
    const res = await window.ostia.chatTools.setMcpSecret(server.name, key, value)
    if (!res.ok) ok = false
  }
  await refreshMcp()
  return ok
}

export function McpServerDialog({
  open,
  server,
  onClose,
}: {
  open: boolean
  server: McpServerSettings | null
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const ids = useId()
  const [original, setOriginal] = useState<McpServerSettings | null>(server)
  const [draft, setDraft] = useState<McpServerDraft>(() => draftFromServer(server))
  const [errors, setErrors] = useState<McpDraftField[]>([])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setOriginal(server)
    setDraft(draftFromServer(server))
    setErrors([])
    setFailed(false)
  }, [open, server])

  const patch = (next: Partial<McpServerDraft>): void => setDraft((cur) => ({ ...cur, ...next }))
  const invalid = (field: McpDraftField): boolean => errors.includes(field)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const taken = useSettingsStore.getState().assistant.mcpServers.map((s) => s.name)
    const result = serverFromDraft(draft, original, taken)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors([])
    setBusy(true)
    try {
      const ok = await storeServer(
        original,
        result.server,
        result.secretValues,
        result.removedSecrets,
      )
      if (ok) {
        onClose()
        return
      }
      setFailed(true)
      setOriginal(result.server)
      setDraft(draftFromServer(result.server))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>
              {original ? fmt(t.editServerTitle, { name: original.name }) : t.addServerTitle}
            </DialogTitle>
            <DialogDescription>{t.mcpDesc}</DialogDescription>
          </DialogHeader>
          <ServerFields
            ids={ids}
            original={original}
            draft={draft}
            errors={errors}
            onPatch={patch}
            onTransport={(transport) => {
              patch({ transport, secrets: [] })
              setErrors([])
            }}
          />
          <SecretRows
            transport={draft.transport}
            rows={draft.secrets}
            error={invalid('secrets') ? t.badSecret : failed ? t.secretFailed : null}
            onChange={(secrets) => patch({ secrets })}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {original ? t.save : t.addServer}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
