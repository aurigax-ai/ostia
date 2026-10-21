import { useState } from 'react'
import { FindBar, type FindStepRef } from '@/components/common/FindBar'
import { useDict } from '@/lib/app/useDict'

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
  stepRef,
}: {
  focusKey: number
  result: FindResult | null
  onSearch: (request: FindRequest) => void
  onClear: () => void
  onClose: () => void
  stepRef?: FindStepRef
}): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')

  const onQuery = (value: string): void => {
    setQuery(value)
    if (value) onSearch({ text: value, forward: true, next: false })
    else onClear()
  }

  const status =
    !query || !result
      ? ''
      : result.total === 0
        ? d.find.noResults
        : `${result.active}/${result.total}`

  return (
    <FindBar
      key={focusKey}
      label={d.browser.findLabel}
      query={query}
      status={status}
      onQuery={onQuery}
      onStep={(by) => {
        if (query) onSearch({ text: query, forward: by > 0, next: true })
      }}
      onClose={onClose}
      stepRef={stepRef}
      className="browser-find"
    />
  )
}
