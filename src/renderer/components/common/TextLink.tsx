import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

type TextLinkProps = Omit<ComponentProps<typeof Button>, 'variant'>

export function TextLink({ className, ...props }: TextLinkProps): JSX.Element {
  return (
    <Button
      variant="link"
      className={cn('text-fg-muted hover:text-fg focus-visible:text-fg', className)}
      {...props}
    />
  )
}
