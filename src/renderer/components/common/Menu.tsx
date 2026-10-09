import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioItem,
  ContextMenuShortcut,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import type { Icon } from '@phosphor-icons/react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'

const ROW = 'h-7 gap-2 rounded-sm px-2 text-ui-base'

function Leading({ icon: IconComponent, leading }: { icon?: Icon; leading?: ReactNode }) {
  if (leading) {
    return (
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
        {leading}
      </span>
    )
  }
  if (IconComponent) return <IconComponent aria-hidden className="size-3.5 text-fg-muted" />
  return <span aria-hidden className="size-3.5 shrink-0" />
}

export function MenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuContent>): JSX.Element {
  return <ContextMenuContent className={cn('min-w-56 text-ui-base', className)} {...props} />
}

export function MenuSubContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuSubContent>): JSX.Element {
  return <ContextMenuSubContent className={cn('min-w-48 text-ui-base', className)} {...props} />
}

export function MenuItem({
  icon,
  leading,
  hint,
  children,
  className,
  ...props
}: ComponentProps<typeof ContextMenuItem> & {
  icon?: Icon
  leading?: ReactNode
  hint?: ReactNode
}): JSX.Element {
  return (
    <ContextMenuItem className={cn(ROW, className)} {...props}>
      <Leading icon={icon} leading={leading} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? (
        <ContextMenuShortcut className="text-ui-xs tracking-normal">{hint}</ContextMenuShortcut>
      ) : null}
    </ContextMenuItem>
  )
}

export function MenuSubTrigger({
  icon,
  children,
  className,
  ...props
}: ComponentProps<typeof ContextMenuSubTrigger> & { icon?: Icon }): JSX.Element {
  return (
    <ContextMenuSubTrigger className={cn(ROW, 'pr-1', className)} {...props}>
      <Leading icon={icon} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenuSubTrigger>
  )
}

export function MenuRadioItem({
  leading,
  children,
  className,
  ...props
}: ComponentProps<typeof ContextMenuRadioItem> & { leading?: ReactNode }): JSX.Element {
  return (
    <ContextMenuRadioItem className={cn(ROW, 'pr-8', className)} {...props}>
      <Leading leading={leading} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenuRadioItem>
  )
}

export function MenuCheckboxItem({
  icon,
  children,
  className,
  ...props
}: ComponentProps<typeof ContextMenuCheckboxItem> & { icon?: Icon }): JSX.Element {
  return (
    <ContextMenuCheckboxItem className={cn(ROW, 'pr-8', className)} {...props}>
      <Leading icon={icon} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenuCheckboxItem>
  )
}

export function MenuLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ContextMenuLabel className="px-2 pt-1.5 pb-1 font-medium text-fg-muted text-ui-xs">
      {children}
    </ContextMenuLabel>
  )
}

export function DropdownMenu({
  trigger,
  children,
  className,
  align = 'end',
  side = 'bottom',
  open,
  onOpenChange,
}: {
  trigger: ReactElement
  children: ReactNode
  className?: string
  align?: 'start' | 'end'
  side?: 'top' | 'bottom'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  return (
    <MenuPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <MenuPrimitive.Trigger render={trigger} />
      <MenuContent side={side} align={align} alignOffset={0} sideOffset={4} className={className}>
        {children}
      </MenuContent>
    </MenuPrimitive.Root>
  )
}
