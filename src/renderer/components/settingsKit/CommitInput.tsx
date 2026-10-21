import { type ComponentProps, useState } from 'react'
import { Input } from '@/components/ui/input'

type InputProps = Omit<
  ComponentProps<typeof Input>,
  'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown'
>

export function CommitInput({
  value,
  onCommit,
  onCancel,
  ...props
}: InputProps & {
  value: string
  onCommit: (text: string) => unknown
  onCancel?: () => void
}): JSX.Element {
  const [edit, setEdit] = useState<{ text: string; base: string } | null>(null)
  const draft = edit?.base === value ? edit.text : null
  const commit = (): void => {
    if (draft === null) return
    if (draft === value) {
      setEdit(null)
      onCancel?.()
    } else if (onCommit(draft) !== false) setEdit(null)
  }
  return (
    <Input
      {...props}
      value={draft ?? value}
      onChange={(e) => setEdit({ text: e.target.value, base: value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape' && draft !== null) {
          e.stopPropagation()
          setEdit(null)
          onCancel?.()
        }
      }}
    />
  )
}

export function NumberInput({
  value,
  min,
  max,
  onCommit,
  ...props
}: InputProps & {
  value: number
  min?: number
  max?: number
  onCommit: (n: number) => void
}): JSX.Element {
  return (
    <CommitInput
      {...props}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={String(value)}
      onCommit={(text) => {
        const n = Number(text)
        if (text.trim() === '' || !Number.isFinite(n)) return undefined
        const clamped = Math.min(
          max ?? Number.POSITIVE_INFINITY,
          Math.max(min ?? Number.NEGATIVE_INFINITY, n),
        )
        if (clamped !== value) onCommit(clamped)
        return undefined
      }}
    />
  )
}
