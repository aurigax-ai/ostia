import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group'
import { useDict } from '@/i18n/useDict'
import { type KeyLike, findStep, matchChord } from '@/lib/keys/chords'
import { isMac } from '@/platform'
import { CaretDownIcon, CaretUpIcon, XIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, type MutableRefObject, useEffect, useRef } from 'react'
import { IconButton } from './IconButton'

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

export type FindStepRef = MutableRefObject<((by: number) => void) | null>

export function findStepKey(e: KeyLike): 1 | -1 | null {
  if (e.key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? -1 : 1
  return findStep(matchChord(e, isMac))
}

export function useFindStepRef(stepRef: FindStepRef | undefined, step: (by: number) => void): void {
  useEffect(() => {
    if (!stepRef) return
    stepRef.current = step
    return () => {
      stepRef.current = null
    }
  })
}

export function FindBar({
  label,
  query,
  status,
  onQuery,
  onStep,
  onClose,
  stepRef,
  className,
}: {
  label: string
  query: string
  status: string
  onQuery: (query: string) => void
  onStep: (by: number) => void
  onClose: () => void
  stepRef?: FindStepRef
  className?: string
}): JSX.Element {
  const d = useDict()
  const inputRef = useRef<HTMLInputElement>(null)
  useFindStepRef(stepRef, onStep)

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
    } else {
      const by = findStepKey(e)
      if (by === null) return
      e.preventDefault()
      e.stopPropagation()
      onStep(by)
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
