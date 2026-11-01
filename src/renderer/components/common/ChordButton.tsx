import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useChordLabel } from '@/lib/keyboard/chords'
import { isMac } from '@/platform'

export function ChordButton({
  command,
  icon,
  label,
  variant = 'default',
  onClick,
}: {
  command: string
  icon: React.ReactNode
  label: string
  variant?: 'default' | 'outline'
  onClick: () => void
}): JSX.Element {
  const keys = useChordLabel(command, isMac)
  return (
    <Button variant={variant === 'outline' ? 'outline' : undefined} onClick={onClick}>
      {icon}
      {label}
      {keys ? (
        <Kbd
          className={
            variant === 'default' ? 'ml-1 bg-primary-foreground/15 text-primary-foreground' : 'ml-1'
          }
        >
          {keys}
        </Kbd>
      ) : null}
    </Button>
  )
}
