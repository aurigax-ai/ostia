import type { JSX } from 'react'
import { themeIconSrc } from '@/lib/extensions/iconTheme'
import { useEffectiveTheme } from '@/lib/theme/theme'
import { cn } from '@/lib/utils'
import { useActiveIconTheme } from '@/stores/extensions/iconThemeStore'
import { fileIcon } from './fileIcon'

export function FileIcon({
  name,
  dir = false,
  open = false,
  className = 'file-icon',
}: {
  name: string
  dir?: boolean
  open?: boolean
  className?: string
}): JSX.Element {
  const theme = useActiveIconTheme()
  const variant = useEffectiveTheme()?.appearance === 'light' ? 'light' : 'dark'
  const entry = { name, dir }
  const src = theme ? themeIconSrc(theme, entry, open, variant) : null
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        className={cn('file-icon-theme', className)}
      />
    )
  }
  const { Icon, color } = fileIcon(entry, open)
  return <Icon size={16} className={className} style={{ color }} />
}
