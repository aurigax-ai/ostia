import { XIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { ListRow } from '@/components/common/ListRow'
import { Notice } from '@/components/common/Notice'
import { SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'

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
  tagOf,
  onChange,
}: {
  label: string
  desc?: string
  items: readonly string[]
  fixed?: readonly string[]
  inherited?: readonly string[]
  placeholder: string
  tagOf?: (item: string) => string | undefined
  onChange: (next: string[]) => Promise<ListEditResult>
}): JSX.Element {
  const d = useDict()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const errorText = (reason: string): string =>
    (d.sandbox.errors as Record<string, string>)[reason] ?? reason
  const tag = (item: string): JSX.Element | null => {
    const name = tagOf?.(item)
    return name ? (
      <Badge variant="outline" className="text-ui-xs">
        {name}
      </Badge>
    ) : null
  }

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
      <SettingsSubgroup title={label} desc={desc} />
      <SettingsList
        label={label}
        empty={d.sandbox.listEmpty}
        add={
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
        }
      >
        {fixed.map((item) => (
          <ListRow
            density="dense"
            key={`f-${item}`}
            title={<span className="font-mono text-fg-muted text-ui-sm">{item}</span>}
            actions={
              <Badge variant="outline" className="text-ui-xs">
                {d.sandbox.always}
              </Badge>
            }
          />
        ))}
        {inherited.map((item) => (
          <ListRow
            density="dense"
            key={`g-${item}`}
            title={<span className="font-mono text-fg-muted text-ui-sm">{item}</span>}
            actions={
              <>
                {tag(item)}
                <Badge variant="outline" className="text-ui-xs">
                  {d.sandbox.global}
                </Badge>
              </>
            }
          />
        ))}
        {items.map((item) => (
          <ListRow
            density="dense"
            key={item}
            title={<span className="font-mono text-ui-sm">{item}</span>}
            actions={
              <>
                {tag(item)}
                <IconButton
                  icon={XIcon}
                  label={fmt(d.sandbox.remove, { item })}
                  onClick={() => void apply(items.filter((i) => i !== item))}
                />
              </>
            }
          />
        ))}
      </SettingsList>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </fieldset>
  )
}
