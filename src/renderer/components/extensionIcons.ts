import {
  BellIcon,
  BookOpenIcon,
  CheckIcon,
  CircleIcon,
  GitBranchIcon,
  GlobeIcon,
  HardDrivesIcon,
  type Icon as IconComponent,
  KanbanIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { ExtensionIcon } from '@shared/extensions'

const ICONS: Record<ExtensionIcon, IconComponent> = {
  puzzle: PuzzlePieceIcon,
  kanban: KanbanIcon,
  'book-open': BookOpenIcon,
  'git-branch': GitBranchIcon,
  globe: GlobeIcon,
  bell: BellIcon,
  server: HardDrivesIcon,
  terminal: TerminalWindowIcon,
  circle: CircleIcon,
  check: CheckIcon,
  alert: WarningIcon,
  shield: ShieldCheckIcon,
}

export function extensionIcon(icon: ExtensionIcon | undefined): IconComponent {
  return icon ? ICONS[icon] : PuzzlePieceIcon
}
