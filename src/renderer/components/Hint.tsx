import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type Side = 'top' | 'bottom' | 'left' | 'right'

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
