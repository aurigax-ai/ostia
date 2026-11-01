import type {
  ExtensionConnectionEntry,
  ExtensionConnectionKind,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionConnections'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { TrashIcon } from '@phosphor-icons/react'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'

interface Draft {
  editing: boolean
  name: string
  kind: string
  fields: Record<string, string>
  secrets: Record<string, string | null>
}

function blankDraft(kind: ExtensionConnectionKind): Draft {
  return {
    editing: false,
    name: '',
    kind: kind.kind,
    fields: Object.fromEntries(kind.fields.map((f) => [f.key, f.default ?? ''])),
    secrets: {},
  }
}

function editDraft(entry: ExtensionConnectionEntry): Draft {
  return {
    editing: true,
    name: entry.name,
    kind: entry.kind,
    fields: { ...entry.fields },
    secrets: {},
  }
}

export function ExtensionConnections({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  const load = useExtensionsStore((s) => s.connections)
  const remove = useExtensionsStore((s) => s.removeConnection)
  const [entries, setEntries] = useState<ExtensionConnectionEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kinds = ext.connectionKinds
  const refresh = useCallback(() => {
    void load(ext.id).then(setEntries)
  }, [load, ext.id])
  useEffect(() => {
    if (kinds.length > 0) refresh()
  }, [kinds.length, refresh])
  if (kinds.length === 0) return null
  const kindTitle = (kind: string): string => kinds.find((k) => k.kind === kind)?.title ?? kind
  const first = kinds[0] as ExtensionConnectionKind
  return (
    <section className="mt-3 flex flex-col" aria-label={d.extensions.connectionsTitle}>
      <ControlRow label={d.extensions.connectionsTitle} desc={d.extensions.connectionsDesc}>
        {draft ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null)
              setDraft(blankDraft(first))
            }}
          >
            {d.extensions.connectionAdd}
          </Button>
        )}
      </ControlRow>
      {entries.length === 0 && !draft ? (
        <p className="text-fg-muted text-ui-sm">{d.extensions.connectionsNone}</p>
      ) : null}
      {entries.map((entry) => (
        <ControlRow
          key={entry.name}
          label={entry.name}
          labelHint={<span className="text-fg-muted text-ui-xs">{kindTitle(entry.kind)}</span>}
        >
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setError(null)
                setDraft(editDraft(entry))
              }}
            >
              {d.extensions.connectionEdit}
            </Button>
            <IconButton
              icon={TrashIcon}
              label={fmt(d.extensions.connectionRemove, { name: entry.name })}
              onClick={() =>
                void remove(ext.id, entry.name).then((problem) => {
                  setError(problem)
                  if (draft?.name === entry.name) setDraft(null)
                  refresh()
                })
              }
            />
          </div>
        </ControlRow>
      ))}
      {draft ? (
        <ConnectionForm
          ext={ext}
          draft={draft}
          setDraft={setDraft}
          saved={entries.find((e) => e.name === draft.name && draft.editing)?.secretsSet ?? []}
          error={error}
          setError={setError}
          onDone={() => {
            setDraft(null)
            refresh()
          }}
        />
      ) : error ? (
        <Notice tone="error">{fmt(d.extensions.connectionError, { error })}</Notice>
      ) : null}
    </section>
  )
}

function ConnectionFieldRows({
  kind,
  draft,
  setDraft,
}: {
  kind: ExtensionConnectionKind
  draft: Draft
  setDraft: (draft: Draft | null) => void
}): JSX.Element {
  return (
    <>
      {kind.fields.map((field) => (
        <ControlRow key={field.key} label={field.title} desc={field.description}>
          {field.type === 'enum' ? (
            <SelectField
              value={draft.fields[field.key] ?? field.default ?? ''}
              label={field.title}
              options={(field.enum ?? []).map((value) => ({ value, label: value }))}
              onChange={(value) =>
                setDraft({ ...draft, fields: { ...draft.fields, [field.key]: value } })
              }
            />
          ) : (
            <Input
              value={draft.fields[field.key] ?? ''}
              spellCheck={false}
              autoComplete="off"
              aria-label={field.title}
              onChange={(e) =>
                setDraft({ ...draft, fields: { ...draft.fields, [field.key]: e.target.value } })
              }
              className="h-7 w-72 font-mono text-ui-sm"
            />
          )}
        </ControlRow>
      ))}
    </>
  )
}

function ConnectionSecretRows({
  kind,
  draft,
  saved,
  setDraft,
}: {
  kind: ExtensionConnectionKind
  draft: Draft
  saved: string[]
  setDraft: (draft: Draft | null) => void
}): JSX.Element {
  const d = useDict()
  return (
    <>
      {kind.secrets.map((secret) => {
        const isSaved = saved.includes(secret.key)
        const cleared = draft.secrets[secret.key] === null
        return (
          <ControlRow
            key={secret.key}
            label={secret.title}
            desc={
              cleared
                ? d.extensions.connectionSecretCleared
                : isSaved
                  ? d.extensions.connectionSecretKeep
                  : secret.description
            }
          >
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={cleared ? '' : (draft.secrets[secret.key] ?? '')}
                autoComplete="off"
                spellCheck={false}
                aria-label={secret.title}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    secrets: { ...draft.secrets, [secret.key]: e.target.value },
                  })
                }
                className="h-7 w-56 font-mono text-ui-sm"
              />
              {isSaved && !cleared ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({ ...draft, secrets: { ...draft.secrets, [secret.key]: null } })
                  }
                >
                  {d.extensions.connectionSecretClear}
                </Button>
              ) : null}
            </div>
          </ControlRow>
        )
      })}
    </>
  )
}

function ConnectionForm({
  ext,
  draft,
  setDraft,
  saved,
  error,
  setError,
  onDone,
}: {
  ext: ExtensionInfo
  draft: Draft
  setDraft: (draft: Draft | null) => void
  saved: string[]
  error: string | null
  setError: (error: string | null) => void
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  const save = useExtensionsStore((s) => s.saveConnection)
  const kind = ext.connectionKinds.find((k) => k.kind === draft.kind) as ExtensionConnectionKind
  const submit = (): void => {
    const secrets = Object.fromEntries(
      Object.entries(draft.secrets).filter(([, v]) => v === null || (v ?? '') !== ''),
    )
    void save(ext.id, {
      name: draft.name,
      kind: draft.kind,
      fields: draft.fields,
      secrets,
    }).then((problem) => {
      setError(problem)
      if (!problem) onDone()
    })
  }
  return (
    <form
      className="mt-1 flex flex-col border-line border-l pl-3"
      aria-label={draft.editing ? draft.name : d.extensions.connectionAdd}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {ext.connectionKinds.length > 1 && !draft.editing ? (
        <ControlRow label={d.extensions.connectionKind}>
          <SelectField
            value={draft.kind}
            label={d.extensions.connectionKind}
            options={ext.connectionKinds.map((k) => ({ value: k.kind, label: k.title }))}
            onChange={(value) => {
              const next = ext.connectionKinds.find((k) => k.kind === value)
              if (next) setDraft({ ...blankDraft(next), name: draft.name })
            }}
          />
        </ControlRow>
      ) : null}
      <ControlRow label={d.extensions.connectionName} desc={d.extensions.connectionNameHint}>
        <Input
          value={draft.name}
          disabled={draft.editing}
          spellCheck={false}
          autoComplete="off"
          aria-label={d.extensions.connectionName}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="h-7 w-56 font-mono text-ui-sm"
        />
      </ControlRow>
      <ConnectionFieldRows kind={kind} draft={draft} setDraft={setDraft} />
      <ConnectionSecretRows kind={kind} draft={draft} saved={saved} setDraft={setDraft} />
      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!draft.name}>
          {d.extensions.connectionSave}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null)
            setDraft(null)
          }}
        >
          {d.extensions.connectionCancel}
        </Button>
      </div>
      {error ? <Notice tone="error">{fmt(d.extensions.connectionError, { error })}</Notice> : null}
    </form>
  )
}
