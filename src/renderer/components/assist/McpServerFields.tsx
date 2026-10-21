import { PlusIcon, XIcon } from '@phosphor-icons/react'
import type { McpServerSettings, McpTransportKind } from '@shared/assist/chatTools'
import { IconButton } from '@/components/common/IconButton'
import { SelectField } from '@/components/settingsKit/SelectField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  type KeyValueRow,
  type McpDraftField,
  type McpServerDraft,
  newRow,
  type SecretDraft,
} from '@/lib/assist/mcpServerForm'

export function ServerFields({
  ids,
  original,
  draft,
  errors,
  onPatch,
  onTransport,
}: {
  ids: string
  original: McpServerSettings | null
  draft: McpServerDraft
  errors: McpDraftField[]
  onPatch: (next: Partial<McpServerDraft>) => void
  onTransport: (transport: McpTransportKind) => void
}): JSX.Element {
  const t = useDict().chatTools
  const invalid = (field: McpDraftField): boolean => errors.includes(field)
  const errorId = (field: McpDraftField): string => `${ids}-${field}-error`
  const transportOptions: { value: McpTransportKind; label: string }[] = [
    { value: 'stdio', label: t.typeCommand },
    { value: 'http', label: t.typeUrl },
  ]
  const stdio = draft.transport === 'stdio'
  return (
    <>
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
            onChange={(e) => onPatch({ name: e.target.value })}
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
              onChange={onTransport}
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
              onChange={(e) => onPatch({ command: e.target.value })}
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
              onChange={(e) => onPatch({ args: e.target.value })}
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
            onChange={(e) => onPatch({ url: e.target.value })}
            className="h-7 font-mono text-ui-sm"
          />
        </Field>
      )}
      {stdio ? (
        <EnvRows
          rows={draft.env}
          error={invalid('env') ? t.badEnv : null}
          onChange={(env) => onPatch({ env })}
        />
      ) : null}
    </>
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

export function SecretRows({
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
