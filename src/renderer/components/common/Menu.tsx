import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import type { Icon } from '@phosphor-icons/react'
import { type ComponentProps, forwardRef, type JSX, type ReactElement, type ReactNode } from 'react'
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

const ROW = 'h-6 gap-2 rounded-sm px-2 text-ui-sm'

function Leading({ icon: IconComponent, leading }: { icon?: Icon; leading?: ReactNode }) {
  if (leading) {
    return (
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        {leading}
      </span>
    )
  }
  if (IconComponent) return <IconComponent aria-hidden className="size-4 text-fg-muted" />
  return <span aria-hidden className="size-4 shrink-0" />
}

export function MenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuContent>): JSX.Element {
  return <ContextMenuContent className={cn('min-w-56 text-ui-sm', className)} {...props} />
}

export function MenuSubContent({
  className,
  ...props
}: ComponentProps<typeof ContextMenuSubContent>): JSX.Element {
  return <ContextMenuSubContent className={cn('min-w-48 text-ui-sm', className)} {...props} />
}

export const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof ContextMenuItem> & {
    icon?: Icon
    leading?: ReactNode
    hint?: ReactNode
  }
>(function MenuItem({ icon, leading, hint, children, className, ...props }, ref) {
  return (
    <ContextMenuItem ref={ref} className={cn(ROW, className)} {...props}>
      <Leading icon={icon} leading={leading} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? (
        <ContextMenuShortcut className="flex items-center gap-1.5 text-ui-xs tracking-normal">
          {hint}
        </ContextMenuShortcut>
      ) : null}
    </ContextMenuItem>
  )
})

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
  detail,
  children,
  className,
  ...props
}: ComponentProps<typeof ContextMenuRadioItem> & {
  leading?: ReactNode
  detail?: ReactNode
}): JSX.Element {
  return (
    <ContextMenuRadioItem
      className={cn(ROW, 'pr-8', detail ? 'h-auto py-1' : null, className)}
      {...props}
    >
      <Leading leading={leading} />
      {detail ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate">{children}</span>
          <span className="truncate text-fg-muted text-ui-xs">{detail}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
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
