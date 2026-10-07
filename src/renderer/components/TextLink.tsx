import type { ComponentProps } from 'react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

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
