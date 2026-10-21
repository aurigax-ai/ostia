import type { ExtensionIcon } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { cn } from '@/lib/utils'
import { extensionIcon } from './extensionIcons'

export function ExtensionTile({
  icon,
  size = 'sm',
}: {
  icon: ExtensionIcon | undefined
  size?: 'sm' | 'lg'
}): JSX.Element {
  const Icon = extensionIcon(icon)
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-surface-2 text-fg',
        size === 'sm' ? 'size-6 rounded-md' : 'size-10 rounded-lg',
      )}
    >
      <Icon aria-hidden className={size === 'sm' ? 'size-4' : 'size-5'} />
    </span>
  )
}
