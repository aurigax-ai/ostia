import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export function SectionTabsList({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsList>, 'variant'>): JSX.Element {
  return (
    <TabsList
      variant="line"
      className={cn(
        'h-8 w-full justify-start gap-0 rounded-none border-line border-b p-0',
        className,
      )}
      {...props}
    />
  )
}

export function SectionTab({
  className,
  ...props
}: ComponentProps<typeof TabsTrigger>): JSX.Element {
  return (
    <TabsTrigger
      className={cn(
        'h-full flex-none gap-1 rounded-none border-0 px-2.5 font-normal text-fg-muted text-ui-sm transition-colors hover:text-fg focus-visible:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-active:font-medium data-active:text-fg dark:text-fg-muted dark:hover:text-fg dark:data-active:text-fg',
        'after:bg-primary group-data-horizontal/tabs:after:bottom-[-1px] group-data-horizontal/tabs:after:h-0.5',
        className,
      )}
      {...props}
    />
  )
}
