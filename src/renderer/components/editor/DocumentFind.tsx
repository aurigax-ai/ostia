import { FindBar, type FindStepRef, findStatus } from '@/components/common/FindBar'
import { useDict } from '@/i18n/useDict'
import { clearFind, findRanges, paintFind } from '@/lib/files/domFind'
import { type RefObject, useEffect, useMemo, useState } from 'react'

export function DocumentFind({
  rootRef,
  content,
  stepRef,
  onClose,
}: {
  rootRef: RefObject<HTMLElement>
  content: string
  stepRef?: FindStepRef
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ranges = useMemo(() => {
    const root = rootRef.current
    return root && content !== undefined ? findRanges(root, query) : []
  }, [rootRef, query, content])

  useEffect(() => clearFind, [])

  useEffect(() => {
    paintFind(ranges, active)
    ranges[active]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [ranges, active])

  return (
    <FindBar
      className="document-find"
      label={d.find.documentLabel}
      query={query}
      status={findStatus(query, ranges.length, active, d.find.noResults)}
      onQuery={(q) => {
        setQuery(q)
        setActive(0)
      }}
      onStep={(by) => {
        if (ranges.length > 0) setActive((i) => (i + by + ranges.length) % ranges.length)
      }}
      onClose={onClose}
      stepRef={stepRef}
    />
  )
}
