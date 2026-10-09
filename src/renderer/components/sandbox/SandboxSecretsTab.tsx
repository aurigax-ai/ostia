import { IconButton } from '@/components/common/IconButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { fmt, useDict } from '@/i18n/useDict'
import { TrashIcon } from '@phosphor-icons/react'
import type { SecretEntry, SecretGrant, SecretGrantMode } from '@shared/secrets'
import { useCallback, useEffect, useState } from 'react'

type ModeChoice = SecretGrantMode | 'none'

export function SandboxSecretsTab({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  const [secrets, setSecrets] = useState<SecretEntry[]>([])
  const [grants, setGrants] = useState<SecretGrant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')

  const load = useCallback(() => {
    void window.ostia.secrets.view(workspaceId).then((view) => {
      if (!view) return
      setSecrets(view.secrets)
      setGrants(view.grants)
    })
  }, [workspaceId])
  useEffect(() => {
    load()
  }, [load])

  const sourceLabel: Record<SecretEntry['source'], string> = {
    host: d.sandbox.secretHost,
    ostia: d.sandbox.secretOstia,
  }
  const modeLabel: Record<ModeChoice, string> = {
    none: d.sandbox.secretNone,
    env: d.sandbox.secretEnv,
    file: d.sandbox.secretFile,
    request: d.sandbox.secretRequest,
  }

  const setMode = async (secret: SecretEntry, mode: ModeChoice): Promise<void> => {
    const rest = grants.filter((g) => g.id !== secret.id)
    const next = mode === 'none' ? rest : [...rest, { id: secret.id, mode }]
    const res = await window.ostia.secrets.setGrants(workspaceId, next)
    if (res.ok) {
      setGrants(res.settings.secrets ?? [])
      setError(null)
    } else {
      setError(d.sandbox.secretGrantFailed)
    }
  }

  const addOstia = async (): Promise<void> => {
    if (!key.trim() || !value) return
    if (await window.ostia.secrets.vaultSet(workspaceId, key.trim(), value)) {
      setKey('')
      setValue('')
      load()
    } else {
      setError(d.sandbox.secretSaveFailed)
    }
  }

  return (
    <fieldset aria-label={d.sandbox.secrets} className="mb-4">
      <ul className="flex flex-col gap-1">
        {secrets.map((secret) => {
          const grant = grants.find((g) => g.id === secret.id)
          const mode: ModeChoice = grant?.mode ?? 'none'
          const choices: ModeChoice[] = ['none', 'env', 'file', 'request']
          return (
            <li key={secret.id} className="flex items-center gap-2 text-ui-sm">
              <Badge variant="outline">{sourceLabel[secret.source]}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-fg">{secret.name}</span>
              {secret.source === 'ostia' ? (
                <IconButton
                  icon={TrashIcon}
                  label={fmt(d.sandbox.remove, { item: secret.name })}
                  onClick={() =>
                    void window.ostia.secrets.vaultDelete(workspaceId, secret.name).then(load)
                  }
                />
              ) : null}
              <Select
                value={mode}
                onValueChange={(next) => void setMode(secret, next as ModeChoice)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={fmt(d.sandbox.secretMode, { name: secret.name })}
                  className="w-fit min-w-40 max-w-80"
                >
                  <span className="min-w-0 truncate">{modeLabel[mode]}</span>
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {modeLabel[choice]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          )
        })}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void addOstia()
        }}
      >
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={d.sandbox.secretKey}
          aria-label={d.sandbox.secretKey}
          className="h-7 w-48 font-mono"
        />
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={d.sandbox.secretValue}
          aria-label={d.sandbox.secretValue}
          className="h-7 flex-1"
        />
        <Button type="submit" variant="outline" size="sm">
          {d.sandbox.add}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {error}
        </p>
      ) : null}
      <p className="mt-2 text-fg-muted text-ui-sm">{d.sandbox.restartNoteSecrets}</p>
    </fieldset>
  )
}
