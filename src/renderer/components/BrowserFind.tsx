import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { IconButton } from './IconButton'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './ui/input-group'

export interface FindResult {
  active: number
  total: number
}

export interface FindRequest {
  text: string
  forward: boolean
  next: boolean
}

export function BrowserFind({
  focusKey,
  result,
  onSearch,
  onClear,
  onClose,
}: {
  focusKey: number
  result: FindResult | null
  onSearch: (request: FindRequest) => void
  onClear: () => void
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (focusKey < 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusKey])

  const step = (forward: boolean): void => {
    if (query) onSearch({ text: query, forward, next: true })
  }

  const onChange = (value: string): void => {
    setQuery(value)
    if (value) onSearch({ text: value, forward: true, next: false })
    else onClear()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      step(!e.shiftKey)
    }
  }

  const status =
    !query || !result
      ? ''
      : result.total === 0
        ? d.find.noResults
        : `${result.active}/${result.total}`

  return (
    <div className="term-find browser-find">
      <InputGroup className="h-7 w-64">
        <InputGroupInput
          ref={inputRef}
          className="text-ui-sm md:text-ui-sm"
          aria-label={d.browser.findLabel}
          placeholder={d.find.placeholder}
          spellCheck={false}
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="term-find-count text-ui-sm tabular-nums" aria-live="polite">
            {status}
          </InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <IconButton icon={CaretUpIcon} label={d.find.previous} onClick={() => step(false)} />
      <IconButton icon={CaretDownIcon} label={d.find.next} onClick={() => step(true)} />
      <IconButton icon={XIcon} label={d.find.close} onClick={onClose} />
    </div>
  )
}
