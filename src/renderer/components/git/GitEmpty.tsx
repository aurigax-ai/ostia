import type { JSX } from 'react'
import { EmptyState } from '@/components/common/EmptyState'

export function GitEmpty({
  title,
  hint,
  tone = 'muted',
}: {
  title: string
  hint?: string
  tone?: 'muted' | 'error'
}): JSX.Element {
  return (
    <EmptyState
      variant="surface"
      size="sm"
      className={`empty ${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      title={title}
      titleClassName={`font-medium tracking-normal ${tone === 'error' ? 'text-attn-fg' : 'text-fg'}`}
      desc={hint}
      descClassName="text-fg-muted"
    />
  )
}
