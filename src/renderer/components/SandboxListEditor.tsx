import { XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { IconButton } from './IconButton'
import { SubHead } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

export type ListEditResult =
  | { ok: true }
  | { ok: false; errors: { value: string; reason: string }[] }

export function SandboxListEditor({
  label,
  desc,
  items,
  fixed = [],
  inherited = [],
  placeholder,
  onChange,
}: {
  label: string
  desc?: string
  items: readonly string[]
  fixed?: readonly string[]
  inherited?: readonly string[]
  placeholder: string
  onChange: (next: string[]) => Promise<ListEditResult>
}): JSX.Element {
  const d = useDict()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const errorText = (reason: string): string =>
    (d.sandbox.errors as Record<string, string>)[reason] ?? reason

  const apply = async (next: string[]): Promise<boolean> => {
    const res = await onChange(next)
    if (res.ok) {
      setError(null)
      return true
    }
    setError(res.errors[0] ? errorText(res.errors[0].reason) : null)
    return false
  }

  const add = async (): Promise<void> => {
    const value = draft.trim()
    if (!value) {
      setError(errorText('empty'))
      return
    }
    if (items.includes(value) || inherited.includes(value)) {
      setDraft('')
      return
    }
    if (await apply([...items, value])) setDraft('')
  }

  return (
    <fieldset aria-label={label} className="mb-4">
      <SubHead title={label} desc={desc} />
      <ul className="mb-2 flex flex-col gap-1">
        {fixed.map((item) => (
          <li
            key={`f-${item}`}
            className="flex items-center gap-2 font-mono text-fg-muted text-ui-sm"
          >
            <span className="min-w-0 flex-1 truncate">{item}</span>
            <Badge variant="outline">{d.sandbox.always}</Badge>
          </li>
        ))}
        {inherited.map((item) => (
          <li
            key={`g-${item}`}
            className="flex items-center gap-2 font-mono text-fg-muted text-ui-sm"
          >
            <span className="min-w-0 flex-1 truncate">{item}</span>
            <Badge variant="outline">{d.sandbox.global}</Badge>
          </li>
        ))}
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2 font-mono text-fg text-ui-sm">
            <span className="min-w-0 flex-1 truncate">{item}</span>
            <IconButton
              icon={XIcon}
              label={fmt(d.sandbox.remove, { item })}
              onClick={() => void apply(items.filter((i) => i !== item))}
            />
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          className="h-7 flex-1 font-mono"
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
    </fieldset>
  )
}
