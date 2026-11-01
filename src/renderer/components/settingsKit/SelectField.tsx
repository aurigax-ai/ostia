import type { JSX } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Highlight, useSearchLeaf } from './SettingsSearch'

export function SelectField<T extends string>({
  value,
  onChange,
  options,
  label,
  width = 'w-fit min-w-44 max-w-80',
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
  width?: string
  disabled?: boolean
}): JSX.Element {
  const current = options.find((o) => o.value === value)?.label ?? value
  useSearchLeaf(options.map((o) => o.label))
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" aria-label={label} className={width} disabled={disabled}>
        <span className="min-w-0 truncate">
          <Highlight text={current} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
