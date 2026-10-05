import { IconButton, type IconButtonProps } from '@/components/IconButton'
import { cn } from '@/lib/utils'
import type { UIMessage } from 'ai'
import type { ComponentProps, HTMLAttributes } from 'react'
import { memo } from 'react'
import Markdown, { type Components, type Options } from 'react-markdown'
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

export type MessageActionProps = Omit<IconButtonProps, 'size'>

export const MessageAction = (props: MessageActionProps) => <IconButton size="row" {...props} />

const REMARK_PLUGINS = [remarkGfm]

export type MessageResponseProps = {
  children: string
  className?: string
  components?: Components
  rehypePlugins?: Options['rehypePlugins']
}

export const MessageResponse = memo(
  ({ className, children, components, rehypePlugins }: MessageResponseProps) => (
    <article className={cn('typeset typeset-ostia min-w-0', className)}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </Markdown>
    </article>
  ),
  (prev, next) =>
    prev.children === next.children &&
    prev.components === next.components &&
    prev.rehypePlugins === next.rehypePlugins &&
    prev.className === next.className,
)

MessageResponse.displayName = 'MessageResponse'
