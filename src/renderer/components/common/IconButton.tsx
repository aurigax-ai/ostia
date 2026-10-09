import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Icon as IconComponent } from '@phosphor-icons/react'
import { type ButtonHTMLAttributes, forwardRef } from 'react'
import { Hint } from './Hint'

const BUTTON_SIZE = { bar: 'icon-sm', row: 'icon-2xs' } as const

export type IconButtonSize = keyof typeof BUTTON_SIZE

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'type'> {
  icon: IconComponent
  label: string
  size?: IconButtonSize
  hintSide?: 'top' | 'bottom' | 'left' | 'right'
  command?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, command, size = 'row', hintSide = 'bottom', className, ...props },
  ref,
) {
  return (
    <Hint label={label} command={command} side={hintSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          buttonVariants({ variant: 'ghost', size: BUTTON_SIZE[size] }),
          'rounded-sm text-fg-muted hover:bg-surface-3 hover:text-fg dark:hover:bg-surface-3 aria-pressed:bg-surface-3 aria-pressed:text-fg',
          className,
        )}
        {...props}
      >
        <Icon />
      </button>
    </Hint>
  )
})
