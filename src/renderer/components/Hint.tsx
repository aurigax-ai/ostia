import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type Side = 'top' | 'bottom' | 'left' | 'right'

/**
 * Wrap any interactive element in a themed, accessible tooltip. Replaces native
 * `title=` so hints look like Pine and work for keyboard focus — critical on the
 * collapsed rail, where labels are otherwise hidden. The child keeps its own
 * markup/handlers (Base UI merges trigger props onto it via `render`).
 */
export function Hint({
  label,
  children,
  side = 'top',
}: {
  label: ReactNode
  children: ReactElement
  side?: Side
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
