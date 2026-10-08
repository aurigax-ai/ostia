import type { ReactElement, ReactNode } from 'react'
import { useChordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type Side = 'top' | 'bottom' | 'left' | 'right'

export function useShortcutHint(command: string | undefined): string | null {
  return useChordLabel(command ?? '', isMac)
}

function withShortcut(label: ReactNode, keys: string | null): ReactNode {
  if (!keys) return label
  return (
    <span className="inline-flex items-center gap-2">
      <span>{label}</span>
      <span className="opacity-70">{keys}</span>
    </span>
  )
}

export function Hint({
  label,
  command,
  children,
  side = 'top',
}: {
  label: ReactNode
  command?: string
  children: ReactElement
  side?: Side
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {command ? <ShortcutLabel label={label} command={command} /> : label}
      </TooltipContent>
    </Tooltip>
  )
}

function ShortcutLabel({ label, command }: { label: ReactNode; command: string }): JSX.Element {
  return <>{withShortcut(label, useShortcutHint(command))}</>
}
