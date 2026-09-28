import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { type ButtonHTMLAttributes, forwardRef } from 'react'
import { Hint } from './Hint'
import { buttonVariants } from './ui/button'

const BUTTON_SIZE = { bar: 'icon-sm', row: 'icon-2xs' } as const

export type IconButtonSize = keyof typeof BUTTON_SIZE

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'type'> {
  icon: LucideIcon
  label: string
  size?: IconButtonSize
  hintSide?: 'top' | 'bottom' | 'left' | 'right'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 'row', hintSide = 'bottom', className, ...props },
  ref,
) {
  return (
    <Hint label={label} side={hintSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          buttonVariants({ variant: 'ghost', size: BUTTON_SIZE[size] }),
          'rounded-sm text-fg-muted hover:bg-surface-3 hover:text-fg dark:hover:bg-surface-3 aria-pressed:bg-surface-3 aria-pressed:text-brand',
          className,
        )}
        {...props}
      >
        <Icon />
      </button>
    </Hint>
  )
})
