import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { UIMessage } from 'ai'
import type { ComponentProps, HTMLAttributes } from 'react'
import { memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role']
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-1',
      from === 'user' ? 'is-user' : 'is-assistant',
      className,
    )}
    data-role={from}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'flex min-w-0 max-w-full flex-col gap-2 overflow-hidden',
      'group-[.is-user]:rounded-md group-[.is-user]:bg-surface-2 group-[.is-user]:px-2.5 group-[.is-user]:py-1.5',
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<'div'>

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn('flex items-center gap-0.5', className)} {...props}>
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip: string
}

export const MessageAction = ({
  tooltip,
  children,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: MessageActionProps) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button size={size} type="button" variant={variant} aria-label={tooltip} {...props}>
          {children}
        </Button>
      }
    />
    <TooltipContent>{tooltip}</TooltipContent>
  </Tooltip>
)

const REMARK_PLUGINS = [remarkGfm]

export type MessageResponseProps = {
  children: string
  className?: string
  components?: Components
}

export const MessageResponse = memo(
  ({ className, children, components }: MessageResponseProps) => (
    <article className={cn('typeset typeset-pine min-w-0', className)}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {children}
      </Markdown>
    </article>
  ),
  (prev, next) =>
    prev.children === next.children &&
    prev.components === next.components &&
    prev.className === next.className,
)

MessageResponse.displayName = 'MessageResponse'

export type MessageToolbarProps = ComponentProps<'div'>

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn('flex w-full items-center justify-between gap-4', className)} {...props}>
    {children}
  </div>
)
