import type { ReactNode } from 'react'
import { IconButton, type IconButtonProps } from '@/components/common/IconButton'

export function FloatPill({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="absolute top-3 right-3 z-20 flex max-w-[calc(100%-24px)] items-center gap-0.5 rounded-[calc(var(--radius-md)+4px)] border border-line-strong bg-surface-2 p-1 text-fg-muted shadow-[0_8px_24px_-12px_var(--bg-sunken)]"
    >
      {children}
    </div>
  )
}

export function FloatPillButton({
  className,
  ...props
}: Omit<IconButtonProps, 'size' | 'hintSide'>): JSX.Element {
  return (
    <IconButton
      size="bar"
      hintSide="bottom"
      className={`min-w-7 [&_svg]:size-4 ${className ?? ''}`}
      {...props}
    />
  )
}
