import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { clearFind, findRanges, paintFind } from '../lib/domFind'
import { IconButton } from './IconButton'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './ui/input-group'

export function DocumentFind({
  rootRef,
  content,
  onClose,
}: {
  rootRef: RefObject<HTMLElement>
  content: string
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ranges = useMemo(() => {
    const root = rootRef.current
    return root && content !== undefined ? findRanges(root, query) : []
  }, [rootRef, query, content])

  useEffect(() => {
    inputRef.current?.focus()
    return clearFind
  }, [])

  useEffect(() => {
    paintFind(ranges, active)
    const target = ranges[active]?.startContainer.parentElement
    target?.scrollIntoView({ block: 'center' })
  }, [ranges, active])

  const step = (by: number): void => {
    if (ranges.length > 0) setActive((i) => (i + by + ranges.length) % ranges.length)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
  }

  const status = !query
    ? ''
    : ranges.length === 0
      ? d.find.noResults
      : `${Math.min(active, ranges.length - 1) + 1}/${ranges.length}`

  return (
    <div className="term-find document-find">
      <InputGroup className="h-7 w-64">
        <InputGroupInput
          ref={inputRef}
          className="text-ui-sm md:text-ui-sm"
          aria-label={d.find.documentLabel}
          placeholder={d.find.placeholder}
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="term-find-count text-ui-sm tabular-nums" aria-live="polite">
            {status}
          </InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <IconButton icon={CaretUpIcon} label={d.find.previous} onClick={() => step(-1)} />
      <IconButton icon={CaretDownIcon} label={d.find.next} onClick={() => step(1)} />
      <IconButton icon={XIcon} label={d.find.close} onClick={onClose} />
    </div>
  )
}
