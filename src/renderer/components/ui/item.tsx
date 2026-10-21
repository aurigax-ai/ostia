import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

function ItemSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn('my-2', className)}
      {...props}
    />
  )
}

const itemVariants = cva(
  'group/item flex w-full flex-wrap items-center rounded-lg border text-sm transition-colors [a]:transition-colors [a]:hover:bg-muted',
  {
    variants: {
      variant: {
        default: 'border-transparent',
        outline: 'border-border',
        muted: 'border-transparent bg-muted/50',
      },
      size: {
        default: 'gap-2.5 px-3 py-2.5',
        sm: 'gap-2.5 px-3 py-2.5',
        xs: 'gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Item({
  className,
  variant = 'default',
  size = 'default',
  render,
  ...props
}: useRender.ComponentProps<'div'> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        className: cn(itemVariants({ variant, size, className })),
      },
      props,
    ),
    render,
    state: {
      slot: 'item',
      variant,
      size,
    },
  })
}

function ItemContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        'flex flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0 [&+[data-slot=item-content]]:flex-none',
        className,
      )}
      {...props}
    />
  )
}

const ItemTitle = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(function ItemTitle(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="item-title"
      className={cn(
        'line-clamp-1 flex w-fit items-center gap-2 text-sm leading-snug font-medium underline-offset-4',
        className,
      )}
      {...props}
    />
  )
})

const ItemDescription = React.forwardRef<HTMLParagraphElement, React.ComponentProps<'p'>>(
  function ItemDescription({ className, ...props }, ref) {
    return (
      <p
        ref={ref}
        data-slot="item-description"
        className={cn(
          'line-clamp-2 text-left text-sm leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
          className,
        )}
        {...props}
      />
    )
  },
)

function ItemActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="item-actions" className={cn('flex items-center gap-2', className)} {...props} />
  )
}

function ItemHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-header"
      className={cn('flex basis-full items-center justify-between gap-2', className)}
      {...props}
    />
  )
}

function ItemFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-footer"
      className={cn('flex basis-full items-center justify-between gap-2', className)}
      {...props}
    />
  )
}

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemSeparator,
  ItemTitle,
}
