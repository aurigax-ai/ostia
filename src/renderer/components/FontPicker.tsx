import { useState } from 'react'
import { useDict } from '../i18n/useDict'
import { localFontFamilies } from '../lib/localFonts'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox'

export function FontPicker({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (family: string) => void
}): JSX.Element {
  const d = useDict()
  const [families, setFamilies] = useState<string[] | null>(null)
  const load = (): void => {
    if (families === null) void localFontFamilies().then(setFamilies)
  }
  const missing = families !== null && families.length > 0 && !families.includes(value)
  return (
    <div className="flex flex-col items-end gap-1">
      <Combobox
        items={families ?? [value]}
        value={value}
        onValueChange={(v) => {
          if (typeof v === 'string' && v) onChange(v)
        }}
        onOpenChange={(open) => {
          if (open) load()
        }}
      >
        <ComboboxInput
          aria-label={label}
          placeholder={d.settings.fontSearch}
          className="h-7 w-56"
          onFocus={load}
        />
        <ComboboxContent>
          <ComboboxEmpty>{d.settings.fontEmpty}</ComboboxEmpty>
          <ComboboxList>
            {(family: string) => (
              <ComboboxItem key={family} value={family} style={{ fontFamily: `"${family}"` }}>
                {family}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {missing ? <span className="text-attn-fg text-ui-xs">{d.settings.fontMissing}</span> : null}
    </div>
  )
}
