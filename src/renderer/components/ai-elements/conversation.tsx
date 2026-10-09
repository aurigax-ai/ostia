import { IconButton } from '@/components/common/IconButton'
import { cn } from '@/lib/utils'
import { ArrowDownIcon } from '@phosphor-icons/react'
import type { ComponentProps, ReactNode } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative min-h-0 flex-1 overflow-y-hidden', className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
)

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-3 px-3 py-2', className)} {...props} />
)

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title: string
  description?: string
  icon?: ReactNode
}

export const ConversationEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div className={cn('flex flex-col gap-1 px-4 py-6', className)} {...props}>
    {icon ? <div className="text-fg-muted">{icon}</div> : null}
    <p className="font-semibold text-fg text-ui-lg">{title}</p>
    {description ? <p className="max-w-[60ch] text-fg-muted text-ui-base">{description}</p> : null}
    {children}
  </div>
)

export type ConversationScrollButtonProps = { label: string; className?: string }

export const ConversationScrollButton = ({ className, label }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return (
    <IconButton
      size="bar"
      icon={ArrowDownIcon}
      label={label}
      hintSide="top"
      className={cn(
        'absolute bottom-2 left-1/2 -translate-x-1/2 border border-line bg-surface-2',
        className,
      )}
      onClick={() => void scrollToBottom('instant')}
    />
  )
}
