import { IconButton } from '@/components/common/IconButton'
import { SelectField } from '@/components/settings/SettingsPanel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/i18n/useDict'
import {
  type KeyValueRow,
  type McpDraftField,
  type McpServerDraft,
  type SecretDraft,
  draftFromServer,
  newRow,
  serverFromDraft,
} from '@/lib/mcpServerForm'
import { refreshMcp } from '@/stores/chatToolsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { PlusIcon, XIcon } from '@phosphor-icons/react'
import type { McpServerSettings, McpTransportKind } from '@shared/chatTools'
import { type FormEvent, useEffect, useId, useState } from 'react'

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
  const errorId = (field: McpDraftField): string => `${ids}-${field}-error`

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

  const transportOptions: { value: McpTransportKind; label: string }[] = [
    { value: 'stdio', label: t.typeCommand },
    { value: 'http', label: t.typeUrl },
  ]
  const stdio = draft.transport === 'stdio'

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
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field
              id={`${ids}-name`}
              label={t.serverName}
              error={invalid('name') ? t.badServerName : null}
              errorId={errorId('name')}
            >
              <Input
                id={`${ids}-name`}
                value={original ? original.name : draft.name}
                disabled={original !== null}
                spellCheck={false}
                autoComplete="off"
                placeholder="github"
                aria-invalid={invalid('name') || undefined}
                aria-describedby={invalid('name') ? errorId('name') : undefined}
                onChange={(e) => patch({ name: e.target.value })}
                className="h-7 font-mono text-ui-sm"
              />
            </Field>
            <div className="grid content-start gap-1">
              <span className="font-medium text-fg text-ui-sm">{t.serverType}</span>
              {original ? (
                <span className="flex h-7 items-center text-fg-muted text-ui-sm">
                  {stdio ? t.typeCommand : t.typeUrl}
                </span>
              ) : (
                <SelectField
                  value={draft.transport}
                  options={transportOptions}
                  label={t.serverType}
                  width="w-32"
                  onChange={(transport) => {
                    patch({ transport, secrets: [] })
                    setErrors([])
                  }}
                />
              )}
            </div>
          </div>
          {stdio ? (
            <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3">
              <Field
                id={`${ids}-command`}
                label={t.command}
                error={invalid('command') ? t.badCommand : null}
                errorId={errorId('command')}
              >
                <Input
                  id={`${ids}-command`}
                  value={draft.command}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="npx"
                  aria-invalid={invalid('command') || undefined}
                  aria-describedby={invalid('command') ? errorId('command') : undefined}
                  onChange={(e) => patch({ command: e.target.value })}
                  className="h-7 font-mono text-ui-sm"
                />
              </Field>
              <Field
                id={`${ids}-args`}
                label={t.args}
                error={invalid('args') ? t.badArgs : null}
                errorId={errorId('args')}
              >
                <Input
                  id={`${ids}-args`}
                  value={draft.args}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="-y @modelcontextprotocol/server-github"
                  aria-invalid={invalid('args') || undefined}
                  aria-describedby={invalid('args') ? errorId('args') : undefined}
                  onChange={(e) => patch({ args: e.target.value })}
                  className="h-7 font-mono text-ui-sm"
                />
              </Field>
            </div>
          ) : (
            <Field
              id={`${ids}-url`}
              label={t.url}
              error={invalid('url') ? t.badUrl : null}
              errorId={errorId('url')}
            >
              <Input
                id={`${ids}-url`}
                type="url"
                value={draft.url}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://example.com/mcp"
                aria-invalid={invalid('url') || undefined}
                aria-describedby={invalid('url') ? errorId('url') : undefined}
                onChange={(e) => patch({ url: e.target.value })}
                className="h-7 font-mono text-ui-sm"
              />
            </Field>
          )}
          {stdio ? (
            <EnvRows
              rows={draft.env}
              error={invalid('env') ? t.badEnv : null}
              onChange={(env) => patch({ env })}
            />
          ) : null}
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

function Field({
  id,
  label,
  error,
  errorId,
  children,
}: {
  id: string
  label: string
  error: string | null
  errorId: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="grid content-start gap-1">
      <Label htmlFor={id} className="text-ui-sm">
        {label}
      </Label>
      {children}
      {error ? (
        <p id={errorId} role="alert" className="text-attn-fg text-ui-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function RowsGroup({
  title,
  desc,
  addLabel,
  onAdd,
  error,
  children,
}: {
  title: string
  desc?: string
  addLabel: string
  onAdd: () => void
  error: string | null
  children: React.ReactNode
}): JSX.Element {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="font-medium text-fg text-ui-sm">{title}</legend>
      {desc ? <p className="text-fg-muted text-ui-xs">{desc}</p> : null}
      {children}
      <div>
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onAdd}>
          <PlusIcon />
          {addLabel}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-attn-fg text-ui-xs">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

function EnvRows({
  rows,
  error,
  onChange,
}: {
  rows: KeyValueRow[]
  error: string | null
  onChange: (rows: KeyValueRow[]) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const set = (i: number, next: Partial<KeyValueRow>): void =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...next } : row)))
  return (
    <RowsGroup
      title={t.envTitle}
      addLabel={t.addEnv}
      onAdd={() => onChange([...rows, newRow()])}
      error={error}
    >
      {rows.map((row, i) => (
        <div key={row.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2">
          <Input
            value={row.key}
            spellCheck={false}
            autoComplete="off"
            placeholder="API_HOST"
            aria-label={t.envKey}
            onChange={(e) => set(i, { key: e.target.value })}
            className="h-7 font-mono text-ui-sm"
          />
          <Input
            value={row.value}
            spellCheck={false}
            autoComplete="off"
            aria-label={t.envValue}
            onChange={(e) => set(i, { value: e.target.value })}
            className="h-7 font-mono text-ui-sm"
          />
          <IconButton
            icon={XIcon}
            label={fmt(t.removeEnv, { key: row.key || String(i + 1) })}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
    </RowsGroup>
  )
}

function SecretRows({
  transport,
  rows,
  error,
  onChange,
}: {
  transport: McpTransportKind
  rows: SecretDraft[]
  error: string | null
  onChange: (rows: SecretDraft[]) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools
  const set = (i: number, next: Partial<SecretDraft>): void =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...next } : row)))
  return (
    <RowsGroup
      title={transport === 'http' ? t.secretsTitleUrl : t.secretsTitleCommand}
      desc={t.secretsDesc}
      addLabel={t.addSecret}
      onAdd={() => onChange([...rows, { ...newRow(), saved: false }])}
      error={error}
    >
      {rows.map((row, i) => (
        <div key={row.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2">
          {row.saved ? (
            <span className="truncate px-2.5 font-mono text-fg text-ui-sm">{row.key}</span>
          ) : (
            <Input
              value={row.key}
              spellCheck={false}
              autoComplete="off"
              placeholder={transport === 'http' ? 'Authorization' : 'API_TOKEN'}
              aria-label={t.secretKey}
              onChange={(e) => set(i, { key: e.target.value })}
              className="h-7 font-mono text-ui-sm"
            />
          )}
          <Input
            type="password"
            value={row.value}
            autoComplete="new-password"
            placeholder={row.saved ? t.secretSaved : undefined}
            aria-label={row.saved ? fmt(t.secretValueFor, { key: row.key }) : t.secretValue}
            onChange={(e) => set(i, { value: e.target.value })}
            className="h-7 text-ui-sm"
          />
          <IconButton
            icon={XIcon}
            label={fmt(t.removeSecret, { key: row.key || String(i + 1) })}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
    </RowsGroup>
  )
}
