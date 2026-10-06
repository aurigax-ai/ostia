import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { useDict } from '../i18n/useDict'
import { IconButton } from './IconButton'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './ui/input-group'

export function findStatus(
  query: string,
  count: number,
  active: number,
  noResults: string,
): string {
  if (!query) return ''
  if (count === 0) return noResults
  return `${Math.min(active, count - 1) + 1}/${count}`
}

export function FindBar({
  label,
  query,
  status,
  onQuery,
  onStep,
  onClose,
  className,
}: {
  label: string
  query: string
  status: string
  onQuery: (query: string) => void
  onStep: (by: number) => void
  onClose: () => void
  className?: string
}): JSX.Element {
  const d = useDict()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onStep(e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div className={`term-find${className ? ` ${className}` : ''}`}>
      <InputGroup className="h-7 w-64">
        <InputGroupInput
          ref={inputRef}
          className="text-ui-sm md:text-ui-sm"
          aria-label={label}
          placeholder={d.find.placeholder}
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="term-find-count text-ui-sm tabular-nums" aria-live="polite">
            {status}
          </InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <IconButton icon={CaretUpIcon} label={d.find.previous} onClick={() => onStep(-1)} />
      <IconButton icon={CaretDownIcon} label={d.find.next} onClick={() => onStep(1)} />
      <IconButton icon={XIcon} label={d.find.close} onClick={onClose} />
    </div>
  )
}
