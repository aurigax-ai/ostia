import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export type ConfirmationProps = ComponentProps<typeof Alert>

export const Confirmation = ({ className, ...props }: ConfirmationProps) => (
  <Alert
    role="group"
    className={cn('flex flex-col gap-2 rounded-md border-line bg-surface-2 px-2.5 py-2', className)}
    {...props}
  />
)

export type ConfirmationTitleProps = ComponentProps<typeof AlertDescription>

export const ConfirmationTitle = ({ className, ...props }: ConfirmationTitleProps) => (
  <AlertDescription className={cn('text-fg text-ui-sm', className)} {...props} />
)

export type ConfirmationActionsProps = ComponentProps<'div'>

export const ConfirmationActions = ({ className, ...props }: ConfirmationActionsProps) => (
  <div className={cn('flex flex-wrap items-center justify-end gap-1.5', className)} {...props} />
)

export type ConfirmationActionProps = ComponentProps<typeof Button>

export const ConfirmationAction = ({ size = 'sm', ...props }: ConfirmationActionProps) => (
  <Button type="button" size={size} {...props} />
)
