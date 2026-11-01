import { TrashIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { IconButton, type IconButtonProps } from '@/components/common/IconButton'
import { cn } from '@/lib/utils'

export function RowRemoveButton({
  className,
  ...props
}: Omit<IconButtonProps, 'icon' | 'size'>): JSX.Element {
  return <IconButton icon={TrashIcon} className={cn('hover:text-attn-fg', className)} {...props} />
}
