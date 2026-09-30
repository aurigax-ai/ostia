import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ArrowUpIcon, StopIcon, XIcon } from '@phosphor-icons/react'
import type { ChatStatus } from 'ai'
import type {
  ComponentProps,
  FormEvent,
  HTMLAttributes,
  KeyboardEventHandler,
  MouseEvent,
  ReactNode,
} from 'react'
import { Children, forwardRef, useCallback, useState } from 'react'

export interface PromptInputMessage {
  text: string
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void
}

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const field = event.currentTarget.elements.namedItem('message')
    const text = field instanceof HTMLTextAreaElement ? field.value : ''
    onSubmit({ text }, event)
  }
  return (
    <form className={cn('w-full', className)} onSubmit={handleSubmit} {...props}>
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
  )
}

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn('contents', className)} {...props} />
)

export type PromptInputTextareaProps = Omit<ComponentProps<typeof InputGroupTextarea>, 'ref'>

export const PromptInputTextarea = forwardRef<HTMLTextAreaElement, PromptInputTextareaProps>(
  function PromptInputTextarea({ onKeyDown, className, ...props }, ref) {
    const [isComposing, setIsComposing] = useState(false)

    const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
      (e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented) return
        if (e.key !== 'Enter' || e.shiftKey) return
        if (isComposing || e.nativeEvent.isComposing) return
        e.preventDefault()
        const { form } = e.currentTarget
        const submit = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null
        if (submit?.disabled) return
        form?.requestSubmit()
      },
      [onKeyDown, isComposing],
    )

    return (
      <InputGroupTextarea
        ref={ref}
        className={cn('field-sizing-content max-h-48 min-h-10', className)}
        name="message"
        onCompositionEnd={() => setIsComposing(false)}
        onCompositionStart={() => setIsComposing(true)}
        onKeyDown={handleKeyDown}
        {...props}
      />
    )
  },
)

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, 'align'>

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn('order-first flex-wrap gap-1', className)}
    {...props}
  />
)

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, 'align'>

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn('justify-between gap-1', className)}
    {...props}
  />
)

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn('flex min-w-0 items-center gap-1', className)} {...props} />
)

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: ReactNode
}

export const PromptInputButton = ({
  variant = 'ghost',
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  const button = (
    <InputGroupButton
      className={cn(className)}
      size={size ?? (Children.count(props.children) > 1 ? 'sm' : 'icon-sm')}
      type="button"
      variant={variant}
      {...props}
    />
  )
  if (!tooltip) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus
  onStop?: () => void
  submitLabel: string
  stopLabel: string
}

export const PromptInputSubmit = ({
  className,
  variant = 'default',
  size = 'icon-sm',
  status,
  onStop,
  onClick,
  children,
  submitLabel,
  stopLabel,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === 'submitted' || status === 'streaming'
  const icon = isGenerating ? <StopIcon /> : status === 'error' ? <XIcon /> : <ArrowUpIcon />

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (isGenerating && onStop) {
      e.preventDefault()
      onStop()
      return
    }
    onClick?.(e as never)
  }

  return (
    <InputGroupButton
      aria-label={isGenerating ? stopLabel : submitLabel}
      className={cn(className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? 'button' : 'submit'}
      variant={variant}
      {...props}
    >
      {children ?? icon}
    </InputGroupButton>
  )
}
