import {
  BellIcon,
  BookOpenIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  CircleIcon,
  GitBranchIcon,
  GlobeIcon,
  HardDrivesIcon,
  type Icon as IconComponent,
  KanbanIcon,
  PlugsIcon,
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
  chat: ChatCircleDotsIcon,
  plugs: PlugsIcon,
}

export function extensionIcon(icon: ExtensionIcon | undefined): IconComponent {
  return icon ? ICONS[icon] : PuzzlePieceIcon
}
