import { BellDot, Diff, type LucideIcon, PanelLeft, Search, Settings } from 'lucide-react'
import { useDict } from '../i18n/useDict'
import { useUIStore } from '../stores/uiStore'
import { Hint } from './Hint'

/** Mock working-tree stat until the real git surface lands (Phase 7). */
const DIFF = { added: 128, removed: 34 }

/**
 * Full-width window + tool control bar.
 *   Left   — sidebar toggle · settings.
 *   Center — a VSCode-style **command center** pill that opens the palette (⌘K).
 *   Right  — git changes (±) · notifications · account, then the OS window controls.
 * The bar is the OS drag handle; interactive children opt out via `.drag-region` CSS.
 * Hints sit below the buttons (`side="bottom"`) — the bar hugs the window's top edge.
 */
export function TopBar(): JSX.Element {
  const d = useDict()
  const toggleRail = useUIStore((s) => s.toggleRail)
  const openSettings = useUIStore((s) => s.openSettings)
  const openPalette = useUIStore((s) => s.openPalette)

  return (
    <header className="topbar drag-region">
      <TopIconButton icon={PanelLeft} label={d.topbar.toggleSidebar} onClick={toggleRail} />
      <TopIconButton icon={Settings} label={d.topbar.settings} onClick={openSettings} />

      <button
        type="button"
        className="command-center"
        onClick={openPalette}
        title={`${d.search.placeholder} (⌘K)`}
      >
        <Search size={13} className="cc-icon" />
        <span className="cc-text">{d.search.command}</span>
        <span className="cc-kbd">⌘K</span>
      </button>

      <div className="topbar-right">
        <Hint label={d.topbar.gitDiff} side="bottom">
          <button type="button" className="topbar-btn topbar-changes" onClick={openPalette}>
            <Diff size={16} />
            <span className="diff-stat">
              <span className="diff-add">+{DIFF.added}</span>
              <span className="diff-del">−{DIFF.removed}</span>
            </span>
          </button>
        </Hint>
        <Hint label={d.topbar.notifications} side="bottom">
          <button type="button" className="topbar-btn topbar-bell" onClick={openPalette}>
            <BellDot size={16} />
          </button>
        </Hint>
        <Hint label={d.topbar.account} side="bottom">
          <button type="button" className="topbar-account" onClick={openSettings}>
            <span className="avatar">M</span>
          </button>
        </Hint>
      </div>
    </header>
  )
}

function TopIconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <Hint label={label} side="bottom">
      <button type="button" className="topbar-btn" onClick={onClick}>
        <Icon size={16} />
      </button>
    </Hint>
  )
}
