import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export type SuggestionsProps = ComponentProps<'div'>

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <div className={cn('flex flex-wrap items-center gap-1.5', className)} {...props}>
    {children}
  </div>
)

export type SuggestionProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string
  onClick?: (suggestion: string) => void
}

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = 'outline',
  size = 'sm',
  children,
  ...props
}: SuggestionProps) => (
  <Button
    className={cn('rounded-full', className)}
    onClick={() => onClick?.(suggestion)}
    size={size}
    type="button"
    variant={variant}
    {...props}
  >
    {children || suggestion}
  </Button>
)
