import { XIcon } from '@phosphor-icons/react'
import { createContext, type JSX, useContext } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { cn } from '@/lib/utils'

export const RailCollapsedContext = createContext(false)

export function RailTab({
  active,
  onSelect,
  onClose,
  closeLabel,
  icon,
  title,
  titleAdornment,
  wrapTitle,
  unread,
  editor,
  onDoubleClick,
  after,
  badge,
}: {
  active: boolean
  onSelect: () => void
  onClose?: () => void
  closeLabel: string
  icon: React.ReactNode
  title: string
  titleAdornment?: React.ReactNode
  wrapTitle?: boolean
  unread?: boolean
  editor?: React.ReactNode
  onDoubleClick?: () => void
  after?: React.ReactNode
  badge?: React.ReactNode
}): JSX.Element {
  const collapsed = useContext(RailCollapsedContext)
  if (editor) {
    return (
      <div className={`rail-tab${active ? ' active' : ''}`}>
        <span className="rail-tab-main">
          {icon}
          {editor}
        </span>
      </div>
    )
  }
  const main = (
    <button
      type="button"
      className="rail-tab-main"
      aria-label={collapsed ? title : undefined}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
    >
      {icon}
      <span className="tab-body">
        <span className="tab-title-row">
          <span className={cn('tab-title', wrapTitle && 'wrap', unread && 'unread')}>{title}</span>
          {titleAdornment}
        </span>
      </span>
      {badge}
    </button>
  )
  if (collapsed) return <div className={`rail-tab${active ? ' active' : ''}`}>{main}</div>
  return (
    <div className={`rail-tab${active ? ' active' : ''}`}>
      {main}
      {onClose ? (
        <span className="tab-actions">
          <IconButton icon={XIcon} label={closeLabel} hintSide="right" onClick={onClose} />
        </span>
      ) : null}
      {after}
    </div>
  )
}
